import { TelegramClient, Api } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";

import { 
    getAllSessions, getAllNumbers, incrementDailyStat, getTodayStats, countNumbers, deleteNumbers, clearAllNumbers,
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
import sharp from 'sharp';
import PDFDocument from 'pdfkit-table';
import PDFPlain from 'pdfkit';
import fs from 'fs'; 
import TelegramBot from 'node-telegram-bot-api';
import { pipeline } from 'node:stream/promises';
import * as XLSX from 'xlsx';

import libphonenumber from 'google-libphonenumber';
const phoneUtil = libphonenumber.PhoneNumberUtil.getInstance();

import fetch from 'node-fetch';

// Global counter for statistics
const statsCounter = {
    totalSms: 0,
    groups: {} // Will store counts per Group ID
};



const apiId = parseInt(process.env.TELEGRAM_API_ID); 
// Add these to handle bulk forwards without spamming
const vzBuffer = {}; 
const vzTimer = {};
const mergeBuffer = {}; // <-- ADD THIS LINE FOR THE FILE MERGER
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || ""); 

const pendingMobileSockets = {}; // Holds the Baileys socket while waiting for the SMS code

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

export let spyMemory = new Set();
export let spyFound = new Set();


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


// 🚀 --- NEW ROCKET BOT SETUP --- 🚀
const rocketApiId = parseInt(process.env.ROCKET_API_ID || "0"); 
const rocketApiHash = process.env.ROCKET_API_HASH || "";
const rocketStringSession = new StringSession(process.env.ROCKET_SESSION || ""); 

let rocketUserBot = null;
if (rocketApiId && rocketApiHash) {
    rocketUserBot = new TelegramClient(rocketStringSession, rocketApiId, rocketApiHash, { 
        connectionRetries: 5,
        useWSS: true 
    });
}

// Helper to keep the second account connected
async function ensureRocketConnected() {
    if (!rocketUserBot) throw new Error("Rocket UserBot credentials not set in Heroku Config Vars.");
    if (!rocketUserBot.connected) {
        console.log("[ROCKET BOT] Connecting...");
        await rocketUserBot.connect();
    }
    try {
        await rocketUserBot.getMe(); 
    } catch (e) {
        console.log("[ROCKET BOT] Session might be invalid. Re-authorizing...");
        await rocketUserBot.connect();
    }
}
// ------------------------------------

// 🚀 --- NEW GETNUM BOT SETUP (For @LolzFack_bot) --- 🚀
const getnumApiId = parseInt(process.env.GETNUM_API_ID || "0"); 
const getnumApiHash = process.env.GETNUM_API_HASH || "";
const getnumStringSession = new StringSession(process.env.GETNUM_SESSION || ""); 

let getnumUserBot = null;
if (getnumApiId && getnumApiHash) {
    getnumUserBot = new TelegramClient(getnumStringSession, getnumApiId, getnumApiHash, { 
        connectionRetries: 5,
        useWSS: true 
    });
}

// Helper to keep the GETNUM account connected
async function ensureGetnumConnected() {
    if (!getnumUserBot) throw new Error("GETNUM UserBot credentials not set in Heroku Config Vars.");
    if (!getnumUserBot.connected) {
        console.log("[GETNUM BOT] Connecting...");
        await getnumUserBot.connect();
    }
    try {
        await getnumUserBot.getMe(); 
    } catch (e) {
        console.log("[GETNUM BOT] Session might be invalid. Re-authorizing...");
        await getnumUserBot.connect();
    }
}
// ------------------------------------


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


// ==========================================
// PAYME SYNC BOT SETUP
// ==========================================
const paymeApiId = parseInt(process.env.PAYME_API_ID || "0"); 
const paymeApiHash = process.env.PAYME_API_HASH || "";
const paymeStringSession = new StringSession(process.env.PAYME_SESSION || ""); 

let paymeUserBot = null;
if (paymeApiId && paymeApiHash) {
    paymeUserBot = new TelegramClient(paymeStringSession, paymeApiId, paymeApiHash, { 
        connectionRetries: 5,
        useWSS: true 
    });
}

async function ensurePaymeConnected() {
    if (!paymeUserBot) throw new Error("PAYME UserBot credentials not set in Config Vars.");
    if (!paymeUserBot.connected) {
        console.log("[PAYME BOT] Connecting...");
        await paymeUserBot.connect();
    }
    try {
        await paymeUserBot.getMe(); 
    } catch (e) {
        console.log("[PAYME BOT] Session might be invalid. Re-authorizing...");
        await paymeUserBot.connect();
    }
}

// ==========================================
// MAIN SYNC ENGINE
// ==========================================
const PAYME_CHAT_USERNAME = "paymennow_bot"; 

export async function syncDatabaseWithChat() {
    console.log("[SYSTEM] Starting 30-minute Database Sync with PAYME chat...");

    try {
        await ensurePaymeConnected();

        // 1. Fetch the last 5000 messages from the chat using the PAYME UserBot
        const messages = await paymeUserBot.getMessages(PAYME_CHAT_USERNAME, { limit: 5000 });
        const chatNumbers = new Set();
        
        // --- NEW: Track duplicates for Telegram Chat cleanup ---
        const seenNumbersInChat = new Set();
        const duplicateMessageIds = [];

        // 2. Extract and normalize all numbers from the chat
        for (const msg of messages) {
            if (msg.message) {
                const foundNumbers = msg.message.match(/\d{7,15}/g); 
                
                if (foundNumbers) {
                    let hasDuplicate = false;

                    for (let rawNum of foundNumbers) {
                        
                        // FORCE VENEZUELA COUNTRY CODE
                        if (rawNum.startsWith('041') || rawNum.startsWith('042')) {
                            rawNum = '58' + rawNum.substring(1); // Changes 042... to 5842...
                        } else if ((rawNum.length === 10) && (rawNum.startsWith('41') || rawNum.startsWith('42'))) {
                            rawNum = '58' + rawNum; // Catch missing leading zeros
                        }

                        const res = normalizeWithCountry(rawNum);
                        if (res && res.num) {
                            const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                            
                            // Check if we already saw this exact number in the chat
                            if (seenNumbersInChat.has(fullPhone)) {
                                hasDuplicate = true;
                            } else {
                                seenNumbersInChat.add(fullPhone);
                                chatNumbers.add(fullPhone);
                            }
                        }
                    }

                    // If the message contained a duplicate number, flag it for deletion
                    if (hasDuplicate) {
                        duplicateMessageIds.push(msg.id);
                    }
                }
            }
        }

        // --- NEW: Execute Telegram Chat Cleanup ---
        if (duplicateMessageIds.length > 0) {
            // Delete in batches of 100 to prevent Telegram FloodWait errors
            for (let i = 0; i < duplicateMessageIds.length; i += 100) {
                const chunk = duplicateMessageIds.slice(i, i + 100);
                try {
                    await paymeUserBot.deleteMessages(PAYME_CHAT_USERNAME, chunk, { revoke: true });
                    await delay(1000); // 1-second delay between batch deletions
                } catch (delErr) {
                    console.error("[SYNC] Failed to delete a batch of duplicates:", delErr.message);
                }
            }
            console.log(`[SYNC] Cleaned up ${duplicateMessageIds.length} duplicate messages from the Telegram chat.`);
        }

        // 3. Fetch all current numbers from your Database
        const allDbDocs = await getAllNumbers(); 
        const dbNumbers = new Set();
        
        allDbDocs.forEach(doc => {
            const rawStr = String(doc.number || doc).replace(/\D/g, '');
            const res = normalizeWithCountry(rawStr);
            if (res && res.num) {
                const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                dbNumbers.add(fullPhone);
            }
        });

        // 4. Perform Two-Way Sync using your batch functions
        const numbersToAdd = [];
        const numbersToRemove = [];

        // A. Find missing numbers to add to the database
        for (const phone of chatNumbers) {
            if (!dbNumbers.has(phone)) {
                numbersToAdd.push(phone);
            }
        }

        // B. Find deleted numbers to remove from the database
        for (const phone of dbNumbers) {
            if (!chatNumbers.has(phone)) {
                numbersToRemove.push(phone);
            }
        }

        // Execute batch database commands
        if (numbersToAdd.length > 0) {
            await addNumbersToDb(numbersToAdd);
        }
        
        if (numbersToRemove.length > 0) {
            await deleteNumbers(numbersToRemove);
        }

        console.log(`[SYNC COMPLETE] Added: ${numbersToAdd.length} | Removed: ${numbersToRemove.length} | Total Synced: ${chatNumbers.size}`);

    } catch (error) {
        console.error("[SYNC ERROR] Failed to sync database:", error.message);
    }
}



// --- HYBRID 24-HOUR CHANNEL SCANNER ---
// Uses UserBot to scan, but SenderBot to warn/pin/kick
export function setupDailyChannelScanner(userBot, senderBot) {
    console.log("🛡️ [SCANNER] Hybrid Channel Sweeper Initialized.");

    // Your exact group, channel, and link
    const ULTAR_OTP_GROUP_ID = "-1003645249777"; 
    const TARGET_CHANNEL_ID = "-1003844497723";  
    const TARGET_CHANNEL_LINK = "https://t.me/+iEEWbmC6Pdw0MDI1";

    const SUBADMIN_IDS = (process.env.SUBADMIN_IDS || '').split(',').map(id => id.trim());
    const ADMIN_ID = process.env.ADMIN_ID;

    // Database File Path to survive server restarts
    const DB_FILE = path.join(process.cwd(), 'scanner_data.json');

    const loadData = () => {
        try {
            if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {}
        return { warnedUsers: [], lastPinnedMsgId: null };
    };

    const saveData = (data) => {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
    };

    // Run every 24 Hours (86,400,000 ms)
    setInterval(async () => {
        console.log("[SCANNER] Starting 24h Channel Sweep...");
        
        let data = loadData();

        try {
            // 1. UNPIN YESTERDAY'S MESSAGE (Using the standard bot)
            if (data.lastPinnedMsgId) {
                try {
                    await senderBot.unpinChatMessage(ULTAR_OTP_GROUP_ID, { message_id: data.lastPinnedMsgId });
                } catch (e) {}
                data.lastPinnedMsgId = null;
                saveData(data);
            }

            // 2. FETCH MEMBERS SILENTLY (Using the UserBot)
            const otpMembers = await userBot.getParticipants(ULTAR_OTP_GROUP_ID);
            const channelMembers = await userBot.getParticipants(TARGET_CHANNEL_ID);

            const channelMemberIds = new Set(channelMembers.map(p => p.id.toString()));

            const usersToWarn = [];
            const newWarnedUsers = [];

            // 3. PROCESS VIOLATORS
            for (const p of otpMembers) {
                const userIdStr = p.id.toString();
                
                // Exclude Bots, Admin, and Subadmins
                if (p.bot || userIdStr === ADMIN_ID || SUBADMIN_IDS.includes(userIdStr)) continue;
                
                // If they are in the group, but NOT in the channel
                if (!channelMemberIds.has(userIdStr)) {
                    if (data.warnedUsers.includes(userIdStr)) {
                        // STRIKE 2: They ignored the warning. Kick them (Using the standard bot).
                        try {
                            await senderBot.banChatMember(ULTAR_OTP_GROUP_ID, userIdStr);
                            await senderBot.unbanChatMember(ULTAR_OTP_GROUP_ID, userIdStr); 
                            console.log(`[SCANNER] Kicked ID: ${userIdStr}`);
                        } catch (e) {}
                        await new Promise(r => setTimeout(r, 2000)); // Anti-spam delay
                    } else {
                        // STRIKE 1: Add to today's warning list
                        usersToWarn.push({ id: userIdStr, name: p.firstName || 'User' });
                        newWarnedUsers.push(userIdStr);
                    }
                }
            }

            // Update memory for tomorrow
            data.warnedUsers = newWarnedUsers;
            saveData(data);

            // 4. SEND WARNING & PIN IT (Using the standard bot)
            if (usersToWarn.length > 0) {
                let tags = usersToWarn.slice(0, 50).map(u => `[${u.name}](tg://user?id=${u.id})`).join(', ');
                if (usersToWarn.length > 50) {
                    tags += `\n*...and ${usersToWarn.length - 50} others.*`;
                }

                const warningText = 
                    `⚠️ **ACTION REQUIRED** ⚠️\n\n` +
                    `The following users are NOT in our main channel. You have **24 hours** to join, or you will be automatically removed from this group:\n\n` +
                    `${tags}`;

                try {
                    const warnMsg = await senderBot.sendMessage(ULTAR_OTP_GROUP_ID, warningText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Join Main Channel', url: TARGET_CHANNEL_LINK }]
                            ]
                        }
                    });

                    // Pin the message
                    await senderBot.pinChatMessage(ULTAR_OTP_GROUP_ID, warnMsg.message_id, { disable_notification: false });
                    
                    data = loadData(); 
                    data.lastPinnedMsgId = warnMsg.message_id; 
                    saveData(data);
                } catch (pinErr) {
                    console.error("[SCANNER] Failed to pin or send. Ensure OTP bot is admin.");
                }
            }

            console.log("[SCANNER] 24h Sweep complete!");

        } catch (e) {
            console.error("[SCANNER ERROR]", e.message);
        }
    }, 86400000); // 86400000 ms = exactly 24 hours
}



export async function initUserBot(activeClients) {
    try {
        console.log("[USERBOT] Starting initialization...");
        await userBot.connect();
        console.log("[USERBOT] Connection established.");
        
        getDedicatedSender(activeClients); 
        
        // Start the Telegram Group Scraper
        await setupLiveOtpForwarder(userBot, activeClients);

        // Start the Custom API Poller
        setupApiOtpForwarder(activeClients);
        
        // ✅ START THE HYBRID CHANNEL SCANNER
        // Create the senderBot instance to pass to the scanner
        const OTP_BOT_TOKEN = "8722377131:AAEr1SsPWXKy8m4WbTJBe7vrN03M2hZozhY";
        const senderBot = new TelegramBot(OTP_BOT_TOKEN, { polling: false });
        
        setupDailyChannelScanner(userBot, senderBot);
        
    } catch (e) {
        console.error("[USERBOT INIT FAIL]", e.message);
    }
}



export function setupLiveOtpForwarder(userBot, activeClients) {
    console.log("[MONITOR] Starting active OTP Polling (Telegram + WhatsApp)...");

    // --- CRITICAL: Sync entities to prevent CHANNEL_INVALID errors ---
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

    const OTP_BOT_TOKEN = "8722377131:AAEr1SsPWXKy8m4WbTJBe7vrN03M2hZozhY";
    const senderBot = new TelegramBot(OTP_BOT_TOKEN, { polling: false });

    const TELEGRAM_TARGET_GROUP = "-1003645249777"; 
    const WHATSAPP_INVITE_CODE = "KGSHc7U07u3IqbUFPQX15q"; 
    
    // ✅ ALL SOURCE GROUPS INCLUDED (With "otpbotsy")
    const SOURCE_GROUPS = ["-1003644661262", "-1003518737176", "-1003645558504", "-1003877396414"]; 

    const groupStates = {};
    SOURCE_GROUPS.forEach(id => { groupStates[id] = { lastMessageId: 0 }; });

    const recentCodes = new Map(); 

    setInterval(async () => {
        try {
            if (!userBot || !userBot.connected) return;

            for (const SOURCE_GROUP_ID of SOURCE_GROUPS) {
                let entity;
                try {
                    // 🚨 SMART ID READER: Handles both numeric IDs (BigInt) and public usernames ("otpbotsy")
                    if (/^-?\d+$/.test(SOURCE_GROUP_ID)) {
                        entity = await userBot.getEntity(BigInt(SOURCE_GROUP_ID));
                    } else {
                        entity = await userBot.getEntity(SOURCE_GROUP_ID);
                    }
                } catch (e) { 
                    continue; 
                }

                // 🚨 BURST CATCHER: Pull up to 15 messages to never miss rapid drops
                const messages = await userBot.getMessages(entity, { limit: 15 });
                if (!messages || messages.length === 0) continue;

                const state = groupStates[SOURCE_GROUP_ID];

                if (state.lastMessageId === 0) {
                    state.lastMessageId = messages[0].id;
                    continue;
                }

                // Filter ALL new messages and sort them oldest-to-newest
                const newMessages = messages.filter(m => m.id > state.lastMessageId).sort((a, b) => a.id - b.id);

                // Loop through every single new message
                for (const latestMsg of newMessages) {
                    state.lastMessageId = latestMsg.id; 
                    
                    let textToSearch = latestMsg.message || "";
                    let replyText = "";
                    try {
                        const replyMsg = await latestMsg.getReplyMessage();
                        if (replyMsg && replyMsg.message) replyText = replyMsg.message;
                    } catch (e) { }

                    const combinedText = textToSearch + "\n" + replyText;
                    let code = null;

                    // Button checker
                    const checkButtons = (rows) => {
                        for (const row of rows) {
                            const btnArray = row.buttons || row; 
                            for (const btn of btnArray) {
                                const btnText = btn.text || "";
                                const btnCodeMatch = btnText.match(/(\d{3})[-\s]?(\d{3})/);
                                if (btnCodeMatch) {
                                    return btnCodeMatch[1] + btnCodeMatch[2];
                                }
                            }
                        }
                        return null;
                    };

                    if (latestMsg.buttons && latestMsg.buttons.length > 0) {
                        code = checkButtons(latestMsg.buttons);
                    }
                    if (!code && latestMsg.replyMarkup && latestMsg.replyMarkup.rows) {
                        code = checkButtons(latestMsg.replyMarkup.rows);
                    }

                    if (!code) {
                        const textCodeMatch = combinedText.match(/(?:\b|[^0-9])(\d{3})[-\s]?(\d{3})(?:\b|[^0-9])/);
                        if (textCodeMatch) code = textCodeMatch[1] + textCodeMatch[2];
                    }

                    if (code) {
                        const now = Date.now();
                        if (recentCodes.has(code) && (now - recentCodes.get(code) < 30000)) continue; 
                        recentCodes.set(code, now);

                        try {
                            await incrementDailyStat(SOURCE_GROUP_ID);
                        } catch (dbErr) {}

                        let platform = "WhatsApp"; 
                        if (combinedText.toLowerCase().includes("business") || combinedText.includes("WB")) {
                            platform = "WA Business"; 
                        } else if (combinedText.includes("FB")) {
                            platform = "Facebook";
                        } 

                        const countryMap = {
                            "VE": { name: "Venezuela", flag: "🇻🇪" },
                            "ZW": { name: "Zimbabwe", flag: "🇿🇼" },
                            "NG": { name: "Nigeria", flag: "🇳🇬" },
                            "GN": { name: "Guinea", flag: "🇬🇳" },
                            "CI": { name: "Côte d'Ivoire", flag: "🇨🇮" },
                            "ID": { name: "Indonesia", flag: "🇮🇩" },
                            "BR": { name: "Brazil", flag: "🇧🇷" },
                            "RU": { name: "Russia", flag: "🇷🇺" },
                            "PK": { name: "Pakistan", flag: "🇵🇰" },
                            "ZA": { name: "South Africa", flag: "🇿🇦" },
                            "PH": { name: "Philippines", flag: "🇵🇭" },
                            "VN": { name: "Vietnam", flag: "🇻🇳" },
                            "US": { name: "United States", flag: "🇺🇸" },
                            "GB": { name: "United Kingdom", flag: "🇬🇧" },
                            "BF": { name: "Burkina Faso", flag: "🇧🇫" },
                            "KG": { name: "Kyrgyzstan", flag: "🇰🇬" },
                            "SN": { name: "Senegal", flag: "🇸🇳" },
                            "DE": { name: "Germany", flag: "🇩🇪" }, 
                            "FR": { name: "France", flag: "🇫🇷" },
                            "ES": { name: "Spain", flag: "🇪🇸" },
                            "IT": { name: "Italy", flag: "🇮🇹" }
                        };

                        let countryCode = "Unknown";
                        // 🚨 EMOJI EXTRACTOR: Look for 📞 and ☎️
                        const countryMatch = combinedText.match(/(?:#([a-zA-Z]{2}))|(?:([a-zA-Z]{2})\s*-\s*(?:#|OTHER|WP|WA|WB|WS|FB|📞|☎️))/i);
                        if (countryMatch) {
                            countryCode = (countryMatch[1] || countryMatch[2]).toUpperCase();
                        } else {
                            const fallbackCountry = combinedText.match(/(?:^|\n)[^\w\n]*([a-zA-Z]{2})\s*-/);
                            if (fallbackCountry) countryCode = fallbackCountry[1].toUpperCase();
                        }

                        // 🚨 STRICT FILTER: Drops unmapped countries
                        if (!countryMap[countryCode]) {
                            continue; 
                        }

                        let fullCountry = countryMap[countryCode].name;
                        let flagEmoji = countryMap[countryCode].flag;

                        let maskedNumber = "Unknown";
                        
                        const unifiedMatch = combinedText.match(/(?:(?:WP|WA|WB|WS|FB|OTHER|📞|☎️)\]?)\s*(?:-\s*)?([^\s┨\n]+)/i);

                        if (unifiedMatch && unifiedMatch[1]) {
                            maskedNumber = unifiedMatch[1];
                        } else {
                            const fallbackMatch = combinedText.match(/\d{2,6}[\u200B-\u200D\uFEFF\u200C]*[*•\u2022.a-zA-Z]{2,}[\u200B-\u200D\uFEFF\u200C]*\d{2,6}/);
                            if (fallbackMatch) maskedNumber = fallbackMatch[0];
                        }
                        
                        maskedNumber = maskedNumber.replace(/[\u200B-\u200D\uFEFF\u200C]/g, '').trim();
                        maskedNumber = maskedNumber.replace(/[*_`\[\]]/g, '•');
                        maskedNumber = maskedNumber.replace(/VIP/gi, '•••');
                        maskedNumber = maskedNumber.replace(/[xX]+/g, '•••');

                                                   // --- INJECTED STRICT SPY LOGIC ---
                        try {
                            // Map the 2-letter OTP group tag to the actual numerical calling code
                            const ccToPrefix = {
                                "VE": "58", "ZW": "263", "NG": "234", "GN": "224", "CI": "225",
                                "ID": "62", "BR": "55", "RU": "7", "PK": "92", "ZA": "27",
                                "PH": "63", "VN": "84", "US": "1", "GB": "44", "BF": "226",
                                "KG": "996", "SN": "221", "DE": "49", "FR": "33", "ES": "34", "IT": "39"
                            };
                            
                            const numPrefix = ccToPrefix[countryCode];
                            const suffixMatch = maskedNumber.match(/\d{3,4}$/);
                            
                            if (numPrefix && suffixMatch && typeof spyMemory !== 'undefined' && spyMemory.size > 0) {
                                const suffix = suffixMatch[0];
                                
                                for (const targetNum of spyMemory) {
                                    // STRICT CHECK: The memory number must start with exact country code AND end with suffix
                                    if (targetNum.startsWith(numPrefix) && targetNum.endsWith(suffix)) {
                                        
                                        const allDbDocs = await getAllNumbers();
                                        const dbSet = new Set(allDbDocs.map(doc => (doc.number || doc).toString()));
                                        
                                        if (!dbSet.has(targetNum)) {
                                            if (typeof spyFound !== 'undefined' && !spyFound.has(targetNum)) {
                                                
                                                // --- NEW WA LIVE CHECK BEFORE SAVING ---
                                                const sock = getDedicatedSender(activeClients);
                                                
                                                if (sock) {
                                                    const jid = `${targetNum}@s.whatsapp.net`;
                                                    try {
                                                        const [waCheck] = await sock.onWhatsApp(jid);
                                                        
                                                        if (waCheck && waCheck.exists) {
                                                            spyFound.add(targetNum);
                                                            console.log(`[SPY CAUGHT & VERIFIED] Active number saved: ${targetNum}`);
                                                        } else {
                                                            console.log(`[SPY IGNORED] Matched but DEAD on WhatsApp: ${targetNum}`);
                                                        }
                                                    } catch (waErr) {
                                                        console.error("Spy WA Check failed:", waErr.message);
                                                    }
                                                } else {
                                                    // Fallback: If no WA bot is connected right now, save it blindly so you don't lose the catch
                                                    spyFound.add(targetNum);
                                                    console.log(`[SPY CAUGHT] Saved blindly (no WA bot connected): ${targetNum}`);
                                                }
                                                
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (spyErr) {
                            console.error("Spy logic error:", spyErr.message);
                        }
                        // --- END SPY LOGIC ---



                        const design = 
                            `╭═════ 𝚄𝙻𝚃𝙰𝚁 𝙾𝚃𝙿 ═════⊷\n` +
                            `┃❃╭──────────────\n` +
                            `┃❃│ Platform : ${platform}\n` +
                            `┃❃│ Country  : ${fullCountry} ${flagEmoji}\n` +
                            `┃❃│ Number   : ${maskedNumber}\n` +
                            `┃❃│ Code     : CODE_FIX\n` +
                            `┃❃╰───────────────\n` +
                            `╰═════════════════⊷`;

                        // Telegram Send
                        try {
                            const formattedText = design.replace('CODE_FIX', `\`${code}\``);

                            const tgMsg = await senderBot.sendMessage(TELEGRAM_TARGET_GROUP, formattedText, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true,
                                reply_markup: { 
                                    inline_keyboard: [
                                        [{ text: `Copy: ${code}`, copy_text: { text: code }, style: 'success' }], 
                                        [
                                            { text: `Owner`, url: `https://t.me/Staries1`, style: 'primary' },
                                            { text: `Channel`, url: `https://t.me/+iEEWbmC6Pdw0MDI1`, style: 'primary' }
                                        ],
                                        [
                                            { text: `💰Rent WhatsApp💰`, url: `https://www.taskm4u.com?code=swla7u`, style: 'primary' }
                                        ]
                                    ] 
                                }
                            });

                            console.log(`[FORWARDED] Code ${code} sent to Telegram.`);

                            // 🚨 DYNAMIC DELETION TIMER
                            // 300,000 ms = 5 minutes | 86,400,000 ms = 24 hours
                            let deleteDelay = 86400000; 
                            if (SOURCE_GROUP_ID === "otpbotsy" || SOURCE_GROUP_ID === "-1003389248033") {
                                deleteDelay = 300000; 
                            }

                            setTimeout(async () => { 
                                try { await senderBot.deleteMessage(TELEGRAM_TARGET_GROUP, tgMsg.message_id); } catch (e) {} 
                            }, deleteDelay);

                        } catch (err) {
                            console.error("❌ [TG SEND ERROR]:", err.message);
                        }

            
                    }
                }
            }
        } catch (e) {
            if (!e.message.includes("Cannot read properties")) console.error("[OTP Grabber Error]:", e.message);
        }
    }, 3000); 
}

                                

// --- UPGRADED CUSTOM API OTP FORWARDER (CRASH-PROOF + SPAM-PROOF) ---
export function setupApiOtpForwarder(activeClients) {
    console.log("[MONITOR] Starting Ultra-Fast & Crash-Proof API OTP Polling...");

    const CUSTOM_API_URL = "http://138.68.2.228/api/v1";
    const API_KEY = process.env.CUSTOM_SMS_API_KEY || "85aea74148ad0c706cd02ef9da317e52184527a7df6d17ca403dbecf66e84773"; 

    const OTP_BOT_TOKEN = "8722377131:AAEr1SsPWXKy8m4WbTJBe7vrN03M2hZozhY";
    const senderBot = new TelegramBot(OTP_BOT_TOKEN, { polling: false });

    const TELEGRAM_TARGET_GROUP = "-1003645249777"; 
    const WHATSAPP_INVITE_CODE = "KGSHc7U07u3IqbUFPQX15q"; 

    // 1. SETUP LOCAL JSON DATABASE
    const DB_FILE = path.join(process.cwd(), 'api_memory.json');
    let processedSmsIds = new Set();
    
    // ✅ THE MAGIC LOCK (Prevents startup spam)
    let isFirstRun = true; 

    // Load memory from file on startup
    try {
        if (fs.existsSync(DB_FILE)) {
            const savedIds = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (savedIds.length > 0) {
                processedSmsIds = new Set(savedIds);
                isFirstRun = false; // We have memory! No need to lock.
                console.log(`[API] Restored ${processedSmsIds.size} old SMS IDs from memory.`);
            }
        }
    } catch (e) {
        console.error("⚠️ [API] Could not read memory file, starting fresh blind run.");
    }

    // Helper function to save memory to file
    const saveMemoryToFile = () => {
        try {
            const idArray = Array.from(processedSmsIds).slice(-1500);
            fs.writeFileSync(DB_FILE, JSON.stringify(idArray));
        } catch (e) {}
    };

    const apiCountryMap = {
        "Venezuela": "🇻🇪", "Brazil": "🇧🇷", "Colombia": "🇨🇴", "Argentina": "🇦🇷", "Peru": "🇵🇪", 
        "Chile": "🇨🇱", "Ecuador": "🇪🇨", "Bolivia": "🇧🇴", "Paraguay": "🇵🇾", "Uruguay": "🇺🇾", 
        "Guyana": "🇬🇾", "Haiti": "🇭🇹", "Dominican Republic": "🇩🇴", "Cuba": "🇨🇺",
        "Zimbabwe": "🇿🇼", "Nigeria": "🇳🇬", "Guinea": "🇬🇳", "South Africa": "🇿🇦", 
        "Burkina Faso": "🇧🇫", "Senegal": "🇸🇳", "Kenya": "🇰🇪", "Egypt": "🇪🇬", "Morocco": "🇲🇦", 
        "Algeria": "🇩🇿", "Ghana": "🇬🇭", "Ivory Coast": "🇨🇮", "Cameroon": "🇨🇲", "Mali": "🇲🇱", 
        "Tanzania": "🇹🇿", "Uganda": "🇺🇬", "Angola": "🇦🇴", "Mozambique": "🇲🇿", "Zambia": "🇿🇲",
        "Rwanda": "🇷🇼", "Sudan": "🇸🇩", "Ethiopia": "🇪🇹", "Somalia": "🇸🇴", "Djibouti": "🇩🇯",
        "Indonesia": "🇮🇩", "Philippines": "🇵🇭", "Vietnam": "🇻🇳", "Malaysia": "🇲🇾", 
        "Thailand": "🇹🇭", "Cambodia": "🇰🇭", "Laos": "🇱🇦", "Myanmar": "🇲🇲", "Singapore": "🇸🇬",
        "India": "🇮🇳", "Pakistan": "🇵🇰", "Bangladesh": "🇧🇩", "Sri Lanka": "🇱🇰", "Nepal": "🇳🇵",
        "China": "🇨🇳", "Japan": "🇯🇵", "South Korea": "🇰🇷", "Taiwan": "🇹🇼", "Hong Kong": "🇭🇰",
        "Russia": "🇷🇺", "Kyrgyzstan": "🇰🇬", "Kazakhstan": "🇰🇿", "Uzbekistan": "🇺🇿", 
        "Tajikistan": "🇹🇯", "Turkmenistan": "🇹🇲", "Turkey": "🇹🇷", "Iran": "🇮🇷", "Iraq": "🇮🇶", 
        "Saudi Arabia": "🇸🇦", "UAE": "🇦🇪", "Yemen": "🇾🇪", "Oman": "🇴🇲", "Jordan": "🇯🇴", 
        "Lebanon": "🇱🇧", "Syria": "🇸🇾", "Israel": "🇮🇱", "Kuwait": "🇰🇼", "Qatar": "🇶🇦", "Bahrain": "🇧🇭",
        "United States": "🇺🇸", "Canada": "🇨🇦", "Mexico": "🇲🇽", "Guatemala": "🇬🇹", 
        "Honduras": "🇭🇳", "El Salvador": "🇸🇻", "Nicaragua": "🇳🇮", "Costa Rica": "🇨🇷", "Panama": "🇵🇦",
        "United Kingdom": "🇬🇧", "France": "🇫🇷", "Germany": "🇩🇪", "Spain": "🇪🇸", "Italy": "🇮🇹",
        "Netherlands": "🇳🇱", "Belgium": "🇧🇪", "Switzerland": "🇨🇭", "Austria": "🇦🇹", "Sweden": "🇸🇪",
        "Norway": "🇳🇴", "Denmark": "🇩🇰", "Finland": "🇫🇮", "Poland": "🇵🇱", "Ukraine": "🇺🇦", 
        "Romania": "🇷🇴", "Greece": "🇬🇷", "Portugal": "🇵🇹", "Czech Republic": "🇨🇿", "Hungary": "🇭🇺",
        "Bulgaria": "🇧🇬", "Serbia": "🇷🇸", "Croatia": "🇭🇷", "Ireland": "🇮🇪",
        "Australia": "🇦🇺", "New Zealand": "🇳🇿", "Fiji": "🇫🇯", "Papua New Guinea": "🇵🇬"
    };

    // The recursive polling function (Prevents overlapping requests)
    const pollApi = async () => {
        try {
            const response = await fetch(`${CUSTOM_API_URL}/sms/list?api_key=${API_KEY}&limit=50&page=1`);
            if (!response.ok) throw new Error("API not reachable");
            const data = await response.json();

            if (data.ok && data.sms && Array.isArray(data.sms)) {
                const recentMessages = data.sms.reverse();
                let hasNewMessages = false;

                for (const sms of recentMessages) {
                    if (processedSmsIds.has(sms.id)) continue;
                    
                    processedSmsIds.add(sms.id);
                    hasNewMessages = true;

                    // Memory limit to keep the bot fast
                    if (processedSmsIds.size > 1500) {
                        const iterator = processedSmsIds.values();
                        processedSmsIds.delete(iterator.next().value);
                    }

                    // ✅ MAGIC LOCK: Memorize but DO NOT process/send on fresh startup
                    if (isFirstRun) continue;

                    const messageText = sms.message || "";
                    let code = null;

                    // Extracts code
                    const textCodeMatch = messageText.match(/(?:\b|[^0-9])(\d{3})[-\s]?(\d{3})(?:\b|[^0-9])/);
                    if (textCodeMatch) code = textCodeMatch[1] + textCodeMatch[2];

                    if (code) {
                        let platform = sms.service || "WhatsApp"; 
                        if (messageText.toLowerCase().includes("business") || messageText.includes("WB")) {
                            platform = "WA Business";
                        }

                        // ✅ RECORD STATS ONLY FOR TRULY NEW MESSAGES
                        try {
                            await incrementDailyStat("EDEN_API");
                        } catch (dbErr) {
                            // Ignore db errors to keep the loop fast
                        }

                        const fullCountry = sms.country || "Unknown";
                        const flagEmoji = apiCountryMap[fullCountry] || "🌍";

                        let rawNumber = sms.phone || "Unknown";
                        let maskedNumber = rawNumber;
                        
                        if (rawNumber !== "Unknown" && rawNumber.length >= 8) {
                            const firstPart = rawNumber.slice(0, 4); 
                            const lastPart = rawNumber.slice(-4);    
                            maskedNumber = `${firstPart}•ULT•${lastPart}`; // ✅ YOUR CUSTOM MASK

                        }

                        const design = 
                            `╭═════ 𝚄𝙻𝚃𝙰𝚁 𝙾𝚃𝙿 ═════⊷\n` +
                            `┃❃╭──────────────\n` +
                            `┃❃│ Platform : ${platform}\n` +
                            `┃❃│ Country  : ${fullCountry} ${flagEmoji}\n` +
                            `┃❃│ Number   : ${maskedNumber}\n` +
                            `┃❃│ Code     : CODE_FIX\n` +
                            `┃❃╰───────────────\n` +
                            `╰═════════════════⊷`;

                        // --- SEND TO TELEGRAM ---
                        try {
                            const formattedText = design.replace('CODE_FIX', `\`${code}\``);
                            const tgMsg = await senderBot.sendMessage(TELEGRAM_TARGET_GROUP, formattedText, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true,
                                reply_markup: { 
                                    inline_keyboard: [
                                        [{ text: `Copy: ${code}`, copy_text: { text: code }, style: 'success' }], 
                                        [
                                            { text: `Owner`, url: `https://t.me/Staries1`, style: 'primary' },
                                            { text: `Channel`, url: `https://t.me/+iEEWbmC6Pdw0MDI1`, style: 'primary' }
                                        ],
                                        // ✅ YOUR CUSTOM BUTTON ROW
                                        [
                                            { text: `💰Rent WhatsApp💰`, url: `https://www.taskm4u.com?code=swla7u`, style: 'primary' }
                                        ]
                                    ] 
                                }
                            });
                            console.log(`[API FORWARDED] Code ${code} sent to Telegram.`);

                            setTimeout(async () => { 
                                try { await senderBot.deleteMessage(TELEGRAM_TARGET_GROUP, tgMsg.message_id); } catch (e) {} 
                            }, 86400000);
                        } catch (err) {}

                        // --- SEND TO WHATSAPP ---
                        const sock = getDedicatedSender(activeClients); 
                        if (sock) {
                            try {
                                const formattedWa = design.replace('CODE_FIX', `*${code}*`);
                                const inviteInfo = await sock.groupGetInviteInfo(WHATSAPP_INVITE_CODE);
                                try {
                                    await sock.sendMessage(inviteInfo.id, { text: formattedWa });
                                } catch (e) {
                                    await sock.groupAcceptInvite(WHATSAPP_INVITE_CODE);
                                    await new Promise(r => setTimeout(r, 2000));
                                    await sock.sendMessage(inviteInfo.id, { text: formattedWa });
                                }
                            } catch (fatalErr) { updateOtpSender(null, true); }
                        }
                    }
                }
                
                // ✅ UNLOCK AFTER THE FIRST BATCH IS READ
                isFirstRun = false; 

                if (hasNewMessages) {
                    saveMemoryToFile();
                }
            }
        } catch (e) {
            // Silently catch errors so the loop doesn't break
        } finally {
            // Wait exactly 1 second AFTER the previous request finishes
            setTimeout(pollApi, 1000);
        }
    };

    // Kick off the infinite loop
    pollApi();
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
        [{ text: "Connect Account" }, { text: "My Numbers" }], // Replaced List All
        [{ text: "/stats" }, { text: "Balance" }]
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
export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, serverUrl = '', qrActiveState = {}, deleteUserAccount = null, startMobileRegistration = null) {

    // NOTE: Returning a dummy function as the real notification logic is now centralized in index.js
    const notifyDisconnection = () => {};


    // Initialize the OTP Bot directly here so it sends the replies
    const OTP_BOT_TOKEN = "8722377131:AAEr1SsPWXKy8m4WbTJBe7vrN03M2hZozhY";
    const senderBot = new TelegramBot(OTP_BOT_TOKEN, { polling: false });

        // --- LISTENER: Trigger when a user sends 3 or 4 digits (NO LIMITS) ---
    bot.onText(/^(\d{3,4})$/, async (msg, match) => {
        const chatId = msg.chat.id;
        
        // ONLY run this feature inside your main OTP Target Group
        if (chatId.toString() !== "-1003645249777") return;

        const searchDigits = match[1]; // Grabs either the 3 or 4 digits they typed
        const now = Date.now();

        // 1. SEND LOADING ANIMATION MESSAGE FIRST
        let loadingMsg = null;
        try {
            loadingMsg = await senderBot.sendMessage(chatId, `**Searching...**\nScanning recent OTPs for \`...${searchDigits}\`...`, { 
                reply_to_message_id: msg.message_id, 
                parse_mode: 'Markdown' 
            });
        } catch(e) {
            console.error("Failed to send loading msg", e);
        }

        // 2. INSTANT OTP SEARCH (Using UserBot)
        try {
            // Fetch the last 100 messages to bypass Telegram's search indexing delay
            const recentMessages = await userBot.getMessages(chatId, { limit: 100 });

            let foundCode = null;
            
            // GramJS dates are in seconds. 10 minutes = 600 seconds.
            const tenMinsAgo = Math.floor(now / 1000) - 600;

            for (const m of recentMessages) {
                // Ignore empty messages or messages older than 10 minutes
                if (!m.message || m.date < tenMinsAgo) continue;

                // Explicitly search for the 3 or 4 digits at the END of the "Number" line 
                const numRegex = new RegExp(`Number[^\\n]*?${searchDigits}\\s*(?:\\n|$)`, 'i');
                const codeMatch = m.message.match(/Code[^\n]*?(\d{3,8})/i);

                if (numRegex.test(m.message) && codeMatch) {
                    foundCode = codeMatch[1];
                    break; // Stop searching once we find the newest match
                }
            }

            // 3. EDIT THE LOADING MESSAGE WITH THE RESULT
            if (loadingMsg) {
                if (foundCode) {
                    const opts = {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: `Copy: ${foundCode}`, copy_text: { text: foundCode }, style: 'primary' }]
                            ]
                        }
                    };
                    await senderBot.editMessageText(`**OTP FOUND!**\nHere is the latest code for \`...${searchDigits}\``, opts).catch(()=>{});
                } else {
                    await senderBot.editMessageText(`**NOT FOUND**\nNo OTP was found for \`...${searchDigits}\` in the last 10 minutes.`, { 
                        chat_id: chatId, 
                        message_id: loadingMsg.message_id, 
                        parse_mode: 'Markdown' 
                    }).catch(()=>{});
                }
            }

            // 4. THE CLEANUP CREW (Delete both messages after 1 minute / 60,000ms)
            setTimeout(async () => {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch(e){}
                if (loadingMsg && loadingMsg.message_id) {
                    try { await senderBot.deleteMessage(chatId, loadingMsg.message_id); } catch(e){}
                }
            }, 60000);

        } catch (e) {
            console.error("OTP Search Error:", e);
            // Clean up the loading message if the search crashed completely
            if (loadingMsg && loadingMsg.message_id) {
                try { await senderBot.deleteMessage(chatId, loadingMsg.message_id); } catch(err){}
            }
        }
    });

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


        // --- /validate command: Filter invalid numbers locally to protect IP Trust Score ---
    bot.onText(/\/validate/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file with /validate");
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only validate .txt files.");
        }

        let statusMsg = await bot.sendMessage(chatId, "[SYSTEM] Downloading file and checking telecom rules locally...");

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const textData = await response.text();

            // Extract all digit strings
            const matches = textData.match(/\d{7,15}/g) || [];
            if (matches.length === 0) {
                return bot.editMessageText("[ERROR] No valid numbers found in the file.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            const uniqueNumbers = [...new Set(matches)];
            
            const validNumbers = [];
            const invalidNumbers = [];

            // Run the local validation loop
            for (const rawNum of uniqueNumbers) {
                try {
                    // Prepend '+' so the library auto-detects the country code
                    const parsedNumber = phoneUtil.parseAndKeepRawInput('+' + rawNum);
                    
                    // isPossibleNumber checks length, isValidNumber checks strict carrier routing rules
                    if (phoneUtil.isPossibleNumber(parsedNumber) && phoneUtil.isValidNumber(parsedNumber)) {
                        validNumbers.push(rawNum);
                    } else {
                        invalidNumbers.push(rawNum);
                    }
                } catch (err) {
                    // If the library throws a parsing error, the number format is completely broken
                    invalidNumbers.push(rawNum);
                }
            }

            // Build the final report
            const finalStats = 
                `[VALIDATION COMPLETE]\n\n` +
                `Total Checked: ${uniqueNumbers.length}\n` +
                `Valid (Safe to Scan): ${validNumbers.length}\n` +
                `Invalid (Junk/Fake): ${invalidNumbers.length}\n\n` +
                `The results have been categorized and attached.`;

            try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}

            if (validNumbers.length === 0 && invalidNumbers.length === 0) {
                return bot.sendMessage(chatId, "[RESULT] File contained no readable digits.");
            }

            // 1. Send the Valid file if it has data
            if (validNumbers.length > 0) {
                const validBuffer = Buffer.from(validNumbers.join('\n'));
                await bot.sendDocument(
                    chatId, 
                    validBuffer, 
                    { caption: finalStats, parse_mode: 'Markdown' }, 
                    { filename: `Valid_Numbers_${Date.now()}.txt`, contentType: 'text/plain' }
                );
            }

            // 2. Send the Invalid file if it has data
            if (invalidNumbers.length > 0) {
                const invalidBuffer = Buffer.from(invalidNumbers.join('\n'));
                // Only attach the full stats to the caption if we didn't already send it with the Valid file
                const invalidCaption = validNumbers.length > 0 ? `[INVALID NUMBERS FILTERED]` : finalStats;
                
                await bot.sendDocument(
                    chatId, 
                    invalidBuffer, 
                    { caption: invalidCaption, parse_mode: 'Markdown' }, 
                    { filename: `Invalid_Numbers_${Date.now()}.txt`, contentType: 'text/plain' }
                );
            }

        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "[ERROR] Validation failed: " + error.message);
        }
    });


        // --- /login : Primary Device (Mobile API) Login ---
    bot.onText(/\/login/, (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        if (msg.chat.id.toString() !== ADMIN_ID) return;

        userState[chatId] = 'WAITING_MOBILE_NUMBER';
        bot.sendMessage(chatId, 
            `**MOBILE API LOGIN**\n\n` +
            `This will log the bot in as a **Primary Device** (like a real phone).\n\n` +
            `Enter the phone number with country code (e.g., 2348123456789):`, 
            { parse_mode: 'Markdown' }
        );
    });

    
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


        // --- /de command: Germany Number Analyzer and Sorter (High Specificity) ---
    bot.onText(/\/de/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file with /de");
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only analyze .txt files.");
        }

        let statusMsg = await bot.sendMessage(chatId, "[SYSTEM] Downloading and analyzing German prefixes...");

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const textData = await response.text();

            // Extract all digit strings
            const rawMatches = textData.match(/\d{10,15}/g) || [];
            if (rawMatches.length === 0) {
                return bot.editMessageText("[ERROR] No valid numerical data found in the file.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            const uniqueRaw = [...new Set(rawMatches)];
            
            // Dynamic buckets for highly specific German prefixes
            const deBuckets = {};
            let totalValid = 0;

            // Strict Validation & Sorting Loop for Germany
            for (const raw of uniqueRaw) {
                let clean = raw.replace(/\D/g, '');
                
                // Strip country code and leading zeros down to the core mobile number
                if (clean.startsWith('49')) clean = clean.substring(2);
                if (clean.startsWith('0')) clean = clean.substring(1);

                // German mobile numbers always start with 15, 16, or 17
                if (clean.length >= 10 && clean.length <= 12 && /^(15|16|17)/.test(clean)) {
                    // Group by the first 5 digits (e.g., 15510, 15511, 15758)
                    const prefix = clean.substring(0, 5);
                    
                    if (!deBuckets[prefix]) {
                        deBuckets[prefix] = [];
                    }
                    deBuckets[prefix].push(clean);
                    totalValid++;
                }
            }

            if (totalValid === 0) {
                return bot.editMessageText("[REPORT] Scan complete. Found 0 valid German mobile numbers in this file.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            // --- WIZARD STEP 1: Prefix Selection ---
            let statsText = `[GERMANY DATA REPORT]\n\nTotal Valid DE Numbers: ${totalValid}\n\nBreakdown by Prefix:\n`;
            let prefixButtons = [];

            // Sort prefixes numerically so the menu looks organized
            const sortedPrefixes = Object.keys(deBuckets).sort();

            for (const prefix of sortedPrefixes) {
                const nums = deBuckets[prefix];
                statsText += `- Prefix 0${prefix}: ${nums.length} numbers\n`;
                prefixButtons.push({ text: `Extract 0${prefix} (${nums.length})`, callback_data: `de_prefix_${prefix}` });
            }
            statsText += `\nWhich data segment would you like to extract?`;

            // Build rows of 3 buttons to prevent taking up the whole screen
            const keyboardRows = [];
            for (let i = 0; i < prefixButtons.length; i += 3) {
                keyboardRows.push(prefixButtons.slice(i, i + 3));
            }
            keyboardRows.push([{ text: `Extract ALL Valid Numbers (${totalValid})`, callback_data: "de_prefix_all" }]);

            const selectedPrefix = await new Promise((resolve) => {
                let isResolved = false;
                
                bot.editMessageText(statsText, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: { inline_keyboard: keyboardRows }
                }).then(() => {
                    const listener = (query) => {
                        if (query.message.message_id === statusMsg.message_id && query.data.startsWith('de_prefix_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            resolve(query.data.replace('de_prefix_', ''));
                        }
                    };
                    bot.on('callback_query', listener);
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve(null); } }, 60000);
                });
            });

            if (!selectedPrefix) {
                return bot.editMessageText("[TIMEOUT] You did not select a prefix in time. Command aborted.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            let coreNumbersArray = [];
            let segmentName = "";
            if (selectedPrefix === 'all') {
                for (const nums of Object.values(deBuckets)) coreNumbersArray.push(...nums);
                segmentName = "All Valid DE Numbers";
            } else {
                coreNumbersArray = deBuckets[selectedPrefix];
                segmentName = `Prefix 0${selectedPrefix}`;
            }

            // --- WIZARD STEP 2: Format Selection ---
            const formatMode = await new Promise((resolve) => {
                let isResolved = false;
                bot.editMessageText(`[FORMAT SELECTION]\nTarget: ${segmentName}\nCount: ${coreNumbersArray.length}\n\nHow should the numbers be formatted?`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Include Country Code (49...)", callback_data: "de_fmt_49" }],
                            [{ text: "Local Format (0...)", callback_data: "de_fmt_0" }]
                        ]
                    }
                }).then(() => {
                    const listener = (query) => {
                        if (query.message.message_id === statusMsg.message_id && query.data.startsWith('de_fmt_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            resolve(query.data.replace('de_fmt_', ''));
                        }
                    };
                    bot.on('callback_query', listener);
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve('49'); } }, 60000);
                });
            });

            // Apply the chosen formatting rule to the entire array
            const finalArray = coreNumbersArray.map(num => formatMode === '49' ? `49${num}` : `0${num}`);

            // --- WIZARD STEP 3: Output Mode Selection ---
            const outputMode = await new Promise((resolve) => {
                let isResolved = false;
                bot.editMessageText(`[OUTPUT SELECTION]\nTarget: ${segmentName}\nCount: ${finalArray.length}\nFormat: ${formatMode === '49' ? '+49' : 'Local 0'}\n\nHow would you like to receive the output?`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Send as .txt File", callback_data: "de_out_file" }],
                            [{ text: "Send in Chat (Batches)", callback_data: "de_out_chat" }]
                        ]
                    }
                }).then(() => {
                    const listener = (query) => {
                        if (query.message.message_id === statusMsg.message_id && query.data.startsWith('de_out_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            resolve(query.data === 'de_out_file' ? 'file' : 'chat');
                        }
                    };
                    bot.on('callback_query', listener);
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve('chat'); } }, 60000);
                });
            });

            // Clean up the prompt message
            try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}

            // --- FINAL DELIVERY ---
            if (outputMode === 'chat') {
                bot.sendMessage(chatId, `[DELIVERY] ${segmentName}\nFormat: ${formatMode === '49' ? 'Country Code Included' : 'Local Format'}\nSending in batches of 10...`);
                for (let i = 0; i < finalArray.length; i += 10) {
                    const chunk = finalArray.slice(i, i + 10);
                    const msgText = chunk.map(n => `\`${n}\``).join('\n');
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                    await new Promise(r => setTimeout(r, 800)); // Rate limit protection
                }
                bot.sendMessage(chatId, "[SYSTEM] Delivery complete.");
            } else {
                const fileBuffer = Buffer.from(finalArray.join('\n'));
                await bot.sendDocument(
                    chatId, 
                    fileBuffer, 
                    { caption: `[DELIVERY COMPLETE]\nSegment: ${segmentName}\nTotal: ${finalArray.length}` }, 
                    { filename: `Ultar_Sync_DE_${segmentName.replace(/\s/g, '_')}_${Date.now()}.txt`, contentType: 'text/plain' }
                );
            }

        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "[ERROR] Analysis failed: " + error.message);
        }
    });

    
      // --- TEMPORARY COMMAND: /reformat (Applies 5-per-batch formatting to old files) ---
    bot.onText(/\/reformat/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file with /reformat");
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only reformat .txt files.");
        }

        let statusMsg = await bot.sendMessage(chatId, "Downloading and applying batch formatting...");

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const rawText = await response.text();

            // Extract all numbers (cleans out any weird characters)
            const rawLines = rawText.split(/\r?\n/).map(l => l.trim().replace(/\D/g, '')).filter(l => l.length > 0);

            if (rawLines.length === 0) {
                return bot.editMessageText("[ERROR] No valid numbers found in the file.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            // Apply the 5-per-batch formatting
            let formattedText = "";
            let batchNum = 1;
            for (let j = 0; j < rawLines.length; j++) {
                // Add batch header for every 5th number
                if (j % 5 === 0) {
                    formattedText += `    ${batchNum}    \n`;
                    batchNum++;
                }
                formattedText += rawLines[j];
                
                // Add spacing between batches
                if ((j + 1) % 5 === 0 && j !== rawLines.length - 1) {
                    formattedText += "\n\n\n"; 
                } else if (j !== rawLines.length - 1) {
                    formattedText += "\n"; 
                }
            }

            const buffer = Buffer.from(formattedText);

            await bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});

            await bot.sendDocument(
                chatId, 
                buffer, 
                { 
                    caption: `**REFORMAT COMPLETE**\n\nTotal Numbers: ${rawLines.length}\nFormat: 5 per batch (Split Style)`, 
                    parse_mode: 'Markdown' 
                },
                { filename: `Ultar_Sync_${doc.file_name}`, contentType: 'text/plain' }
            );

        } catch (error) {
            bot.editMessageText(`**[ERROR]** ${error.message}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
        }
    });


    // --- /txt [Reply to file] ---
    bot.onText(/\/txt/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .vcf file with /txt');
        }

        const fileName = msg.reply_to_message.document.file_name || '';
        if (fileName.toLowerCase().endsWith('.xlsx')) {
            return bot.sendMessage(chatId, '[ERROR] This is an Excel file. Please use /xl instead.');
        }

        const fileId = msg.reply_to_message.document.file_id;
        userState[chatId + '_txt_file'] = fileId;

        // --- NEW: QUICK PRE-ANALYSIS ---
        let statusMsg = await bot.sendMessage(chatId, '⏳ Analyzing file...');
        try {
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const rawText = await response.text();
            
            // Extract and count unique numbers quickly
            const rawMatches = rawText.match(/\d{7,15}/g) || [];
            const uniqueNumbers = Array.from(new Set(rawMatches));
            
            let detectedCountry = "Unknown";
            let detectedCode = "N/A";
            
            // Fast loop to find the first identifiable country for the prompt
            for (const num of uniqueNumbers) {
                const res = normalizeWithCountry(num);
                if (res && res.name && res.name !== "Local/Unknown") {
                    detectedCountry = res.name;
                    detectedCode = res.code;
                    break; 
                }
            }

            await bot.deleteMessage(chatId, statusMsg.message_id);

            bot.sendMessage(chatId, 
                `**FILE ANALYSIS**\n` +
                `Total Input Found: ${uniqueNumbers.length}\n` +
                `Country Detected: ${detectedCountry} (+${detectedCode})\n\n` +
                `*Select TXT Processing Mode:*\n\n` +
                `*Streaming Mode:* Deep checks numbers on WA.\n` +
                `*Normal Mode:* Only filters out DB/Connected.`, 
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Streaming Mode (Check WA)', callback_data: 'txt_menu_stream' }],
                            [{ text: 'Normal Mode (Filter Only)', callback_data: 'txt_menu_normal' }],
                            [{ text: 'Cancel', callback_data: 'cancel_action' }]
                        ]
                    }
                }
            );

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] Failed to analyze file: ${e.message}`);
        }
    });


    // --- /split [Country]: Initiate File Splitting ---
    bot.onText(/\/split(?:\s+(.+))?/i, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file with /split [CountryName]\nExample: /split Germany");
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only split .txt files.");
        }

        // Capture the text typed after the command, default to "Data" if left blank
        const customCountry = match[1] ? match[1].trim() : "Data";

        userState[chatId] = 'WAITING_SPLIT_COUNT';
        userState[chatId + '_split_file'] = doc.file_id;
        
        // Save the custom label to RAM so the next step can use it
        userState[chatId + '_split_country'] = customCountry; 

        bot.sendMessage(chatId, `[SPLIT INITIATED]\nTarget File: ${doc.file_name}\nLabel: ${customCountry}\n\nReply to this message with the number of parts you want to split this file into (e.g., 5).`);
    });



        // --- USERBOT PRIVATE GROUP FINDER ---
    bot.onText(/\/findgroup (.+)/i, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        const keyword = match[1].toLowerCase();
        
        try {
            bot.sendMessage(msg.chat.id, `Asking UserBot to search your chats for: "${keyword}"...`);
            
            // The UserBot fetches all your active chats
            const dialogs = await userBot.getDialogs();
            
            let text = `**Search Results for "${keyword}":**\n\n`;
            let found = 0;
            
            for (const dialog of dialogs) {
                // Filter for groups/channels that match the keyword
                if (dialog.title && dialog.title.toLowerCase().includes(keyword)) {
                    text += `**Name:** ${dialog.title}\n`;
                    text += `**ID:** \`${dialog.id.toString()}\`\n\n`;
                    found++;
                }
            }
            
            if (found === 0) {
                text = `No groups or channels found matching "${keyword}". Try a different word!`;
            }
            
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
            
        } catch(e) {
            bot.sendMessage(msg.chat.id, `[ERROR] Search failed: ${e.message}`);
        }
    });



    // --- /ttx [Reply to file] ---
    bot.onText(/\/ttx/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .vcf file with /ttx');
        }

        userState[chatId + '_ttx_file'] = msg.reply_to_message.document.file_id;

        bot.sendMessage(chatId, 
            `*Select TTX Processing Mode:*\n\n` +
            `*Streaming Mode:* Deep checks numbers on WA.\n` +
            `*Normal Mode:* Only filters out DB/Connected.\n\n` +
            `*Note: Cross-country formatting is enabled automatically.*`, 
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Streaming Mode (Check WA)', callback_data: 'ttx_menu_stream' }],
                        [{ text: 'Normal Mode (Filter Only)', callback_data: 'ttx_menu_normal' }],
                        [{ text: 'Cancel', callback_data: 'cancel_action' }]
                    ]
                }
            }
        );
    });



        // --- /addfile : File Merger Command ---
    bot.onText(/\/addfile/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .vcf file with /addfile to bank its numbers.');
        }

        try {
            bot.sendMessage(chatId, '[PROCESSING] Extracting numbers for merge...');

            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const rawText = await response.text();

            const matches = rawText.match(/\d{7,15}/g) || [];
            
            if (matches.length === 0) {
                return bot.sendMessage(chatId, '[ERROR] No valid numbers found in this file.');
            }

            // Initialize the memory buffer if it's empty
            if (!mergeBuffer[chatId]) mergeBuffer[chatId] = new Set();

            let addedCount = 0;
            for (const num of matches) {
                const res = normalizeWithCountry(num);
                if (res && res.num) {
                    // Standardize formatting before saving
                    const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                    if (!mergeBuffer[chatId].has(fullPhone)) {
                        mergeBuffer[chatId].add(fullPhone);
                        addedCount++;
                    }
                }
            }

            const totalStored = mergeBuffer[chatId].size;

            bot.sendMessage(chatId, 
                `**MERGE BUFFER UPDATED**\n\n` +
                `Added from this file: ${addedCount} (Unique)\n` +
                `**Total Temporarily Saved:** ${totalStored}\n\n` +
                `Reply to another file with /addfile to keep adding, or click below to pour them all into one file.`, 
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Drop File (Merge All)', callback_data: 'drop_merged_file' }],
                            [{ text: 'Clear Buffer', callback_data: 'clear_merge_buffer' }]
                        ]
                    }
                }
            );

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] ${e.message}`);
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


        
        // --- /checknum : Hyper-Strict Ghost Detection ---
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
            return bot.sendMessage(chatId, "[ERROR] No WhatsApp bots connected to perform check.");
        }

        const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
        const jid = `${fullPhone}@s.whatsapp.net`;

        try {
            bot.sendMessage(chatId, "[CHECKING] Scanning +" + fullPhone + "...");

            // 1. Passive Check (Hits the Ghost Registry)
            const [waCheck] = await sock.onWhatsApp(jid);

            if (waCheck && waCheck.exists) {
                
                // 2. HYPER-STRICT "Profile Wipe" Check
                let isGhost = false;
                let statusInfo = null;
                
                try {
                    // Fetch the "About" text
                    statusInfo = await sock.fetchStatus(jid);
                    
                    // 🚨 THE FIX: Check if the data is literally blank/null. 
                    // Wiped banned accounts often return an empty object instead of an error.
                    if (!statusInfo || !statusInfo.status) {
                        isGhost = true;
                    }
                } catch (statusErr) {
                    // If it throws an actual 401/404 error, it's definitely wiped.
                    isGhost = true; 
                }

                if (isGhost) {
                    bot.sendMessage(chatId, 
                        "[RESULT] +" + fullPhone + "\n" +
                        "Status: LIKELY BANNED (GHOST) 👻\n" +
                        "Detail: Number is in the registry, but its profile data is completely wiped or inaccessible. This is highly likely a permanently banned account."
                    );
                } else {
                    bot.sendMessage(chatId, 
                        "[RESULT] +" + fullPhone + "\n" +
                        "Status: ACTIVE\n" +
                        "Detail: Number is currently live and returned valid profile data: \n📝 '" + statusInfo.status + "'"
                    );
                }

            } else {
                bot.sendMessage(chatId, 
                    "[RESULT] +" + fullPhone + "\n" +
                    "Status: NOT REGISTERED / PURGED\n" +
                    "Detail: This number is either completely clean or has been permanently banned and fully purged from WhatsApp's system."
                );
            }

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "[ERROR] Check failed: " + e.message);
        }
    });


        // --- /remgrp [@username] : Force-remove a user from BOTH the Group and Channel ---
    bot.onText(/\/remgrp\s+(.+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        // Authorization check
        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        let targetUser = match[1].trim();
        
        // Ensure the @ symbol is there for GramJS to resolve it properly
        if (!targetUser.startsWith('@') && isNaN(targetUser)) {
            targetUser = '@' + targetUser;
        }

        // --- CONFIGURATION ---
        const TARGET_GROUP = "-1003645249777";   // Your ULTAR_OTP_GROUP_ID
        const TARGET_CHANNEL = "-1003844497723"; // Your Main Channel ID

        if (!userBot || !userBot.connected) {
            return bot.sendMessage(chatId, "❌ [ERROR] UserBot is not connected. I need the UserBot active to execute this.");
        }

        let statusMsg = await bot.sendMessage(chatId, `⏳ Resolving ${targetUser} and executing removal protocol...`);

        try {
            // In the Telegram API, "kicking" a user means restricting their right to view messages.
            const banPayload = new Api.ChatBannedRights({
                untilDate: 0,
                viewMessages: true // True means the right is RESTRICTED (they are kicked/banned)
            });

            let groupStatus = "Skipped";
            let channelStatus = "Skipped";

            // 1. Remove from Main Group
            try {
                await userBot.invoke(new Api.channels.EditBanned({
                    channel: TARGET_GROUP,
                    participant: targetUser,
                    bannedRights: banPayload
                }));
                groupStatus = "Successfully Removed";
            } catch (gErr) {
                groupStatus = `Failed: _${gErr.message}_`;
            }

            // 2. Remove from Main Channel
            try {
                await userBot.invoke(new Api.channels.EditBanned({
                    channel: TARGET_CHANNEL,
                    participant: targetUser,
                    bannedRights: banPayload
                }));
                channelStatus = "Successfully Removed";
            } catch (cErr) {
                channelStatus = `Failed: _${cErr.message}_`;
            }

            // Final Report
            bot.editMessageText(
                `**[REMOVAL REPORT: ${targetUser}]**\n\n` +
                `**Main Group:**\n${groupStatus}\n\n` +
                `**Main Channel:**\n${channelStatus}`, 
                { 
                    chat_id: chatId, 
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );

        } catch (e) {
            console.error("RemGrp Error:", e);
            bot.editMessageText(`**[FATAL ERROR]** Failed to process ${targetUser}:\n_${e.message}_`, { 
                chat_id: chatId, 
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    });

    

   bot.onText(/\/dbscan/, async (msg) => {
    deleteUserCommand(bot, msg);
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    // Authorization Check
    const isUserAdmin = (userId === ADMIN_ID);
    const isSubAdmin = SUBADMIN_IDS && SUBADMIN_IDS.includes(userId);
    if (!isUserAdmin && !isSubAdmin) return;

    // Ensure user replied to a file
    if (!msg.reply_to_message || !msg.reply_to_message.document) {
        return bot.sendMessage(chatId, "[ERROR] You must reply to a .txt or .xlsx file with /dbscan");
    }

    const document = msg.reply_to_message.document;
    const fileName = document.file_name.toLowerCase();
    
    if (!fileName.endsWith('.txt') && !fileName.endsWith('.xlsx')) {
        return bot.sendMessage(chatId, "[ERROR] Only .txt and .xlsx files are supported.");
    }

    const statusMsg = await bot.sendMessage(chatId, "[SYSTEM] Downloading file and loading database... Please wait.");

    try {
        const fileId = document.file_id;
        const fileLink = await bot.getFileLink(fileId);
        const response = await fetch(fileLink);
        
        let fileNumbers = [];

        if (fileName.endsWith('.txt')) {
            const rawText = await response.text();
            fileNumbers = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        } else if (fileName.endsWith('.xlsx')) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            fileNumbers = data.flat().map(String).map(l => l.trim()).filter(l => l.length > 0);
        }

        const allDbDocs = await getAllNumbers(); 
        const dbSet = new Set();
        
        allDbDocs.forEach(doc => {
            const rawStr = String(doc.number || doc).replace(/\D/g, '');
            const res = normalizeWithCountry(rawStr);
            if (res && res.num) {
                const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                dbSet.add(fullPhone);
            } else {
                dbSet.add(rawStr);
            }
        });

        const foundNumbers = new Set(); 
        let totalChecked = 0;

        for (const line of fileNumbers) {
            const res = normalizeWithCountry(line);
            if (!res || !res.num) continue; 
            
            totalChecked++;
            const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
            
            if (dbSet.has(fullPhone)) {
                foundNumbers.add(res.num);
            }
        }

        const foundArray = Array.from(foundNumbers);

        if (foundArray.length === 0) {
            return bot.editMessageText(`[RESULT] Scan complete. Checked ${totalChecked} numbers. None of them were found in the database.`, { chat_id: chatId, message_id: statusMsg.message_id });
        }

        await bot.editMessageText(`[SYSTEM] Scan complete. Checked ${totalChecked} numbers.\nFound ${foundArray.length} numbers already in the database.\n\nSending in standard batches...`, { chat_id: chatId, message_id: statusMsg.message_id });

        // Standard Batch Output (5 items per batch, tap-to-copy)
        const BATCH_SIZE = 5;
        for (let i = 0; i < foundArray.length; i += BATCH_SIZE) {
            const chunk = foundArray.slice(i, i + BATCH_SIZE);
            const formattedChunk = chunk.map(n => `\`${n}\``).join('\n'); 
            
            const startNum = i + 1;
            const endNum = Math.min(i + BATCH_SIZE, foundArray.length);
            
            await bot.sendMessage(chatId, `[BATCH] ${startNum}-${endNum}\n\n${formattedChunk}`, { parse_mode: 'Markdown' });
            
            await new Promise(resolve => setTimeout(resolve, 800)); // Standard 800ms delay between batches
        }

        bot.sendMessage(chatId, "[PROCESS COMPLETE] All matching numbers have been sent.");

    } catch (error) {
        console.error("DB Scan Error:", error);
        bot.sendMessage(chatId, "[ERROR] Failed to process the scan: " + error.message);
    }
});


        // --- /xl [Reply to file] ---
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

        const fileName = msg.reply_to_message.document.file_name || '';
        if (!fileName.toLowerCase().endsWith('.xlsx')) {
            return bot.sendMessage(chatId, '[ERROR] The /xl command only works with .xlsx files.');
        }

        try {
            bot.sendMessage(chatId, '[ANALYZING] Reading Excel file to map countries...');

            const fileId = msg.reply_to_message.document.file_id;
            
            // Store file ID temporarily so we can process it later
            userState[chatId + '_xl_file'] = fileId;

            // 1. Download and read Excel file
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const buffer = await response.buffer();
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }); 

            // 2. Group numbers by country
            const countrySummary = {};
            let totalChecked = 0;

            data.forEach(row => {
                if (!Array.isArray(row)) return;
                row.forEach(cell => {
                    if (!cell) return;
                    
                    const cellStr = cell.toString();
                    const matches = cellStr.match(/\d{7,15}/g); // Extract raw digits
                    
                    if (matches) {
                        matches.forEach(num => {
                            totalChecked++;
                            const res = normalizeWithCountry(num);
                            if (res && res.code) {
                                const code = res.code;
                                if (!countrySummary[code]) {
                                    countrySummary[code] = { name: res.name, count: 0 };
                                }
                                countrySummary[code].count++;
                            }
                        });
                    }
                });
            });

            const codesFound = Object.keys(countrySummary);
            if (codesFound.length === 0) {
                return bot.sendMessage(chatId, '[ERROR] No valid numbers found in the file.');
            }

            // 3. Build Interactive Buttons for each country found
            const inlineKeyboard = [];
            codesFound.forEach(code => {
                const name = countrySummary[code].name;
                const count = countrySummary[code].count;
                inlineKeyboard.push([{ 
                    text: `${name} (+${code}) - ${count} nums`, 
                    callback_data: `xl_c_${code}` 
                }]);
            });
            inlineKeyboard.push([{ text: 'Cancel', callback_data: 'cancel_action' }]);

            bot.sendMessage(chatId, 
                `**FILE ANALYSIS COMPLETE**\n\n` +
                `**Total Scanned:** ${totalChecked}\n` +
                `**Regions Detected:** ${codesFound.length}\n\n` +
                `Please select which country you want to extract and process:`, 
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }
            );

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] ${e.message}`);
        }
    });



        // --- /info [number] : Full WhatsApp Reconnaissance Report ---
    bot.onText(/\/info\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        let rawNum = match[1].replace(/[^0-9]/g, '');
        if (rawNum.length < 7 || rawNum.length > 15) {
            return bot.sendMessage(chatId, '**[ERROR]** Invalid number format.', { parse_mode: 'Markdown' });
        }

        // 1. Get an active WhatsApp socket
        const activeFolders = Object.keys(clients).filter(f => clients[f]);
        if (activeFolders.length === 0) {
            return bot.sendMessage(chatId, '**[ERROR]** No WhatsApp bots connected.', { parse_mode: 'Markdown' });
        }
        const sock = clients[activeFolders[0]];
        const checkerNum = sock.user.id.split(':')[0];

        let jid = `${rawNum}@s.whatsapp.net`;
        let statusMsg = await bot.sendMessage(chatId, `**[RECONNAISSANCE]**\nFetching intel on \`+${rawNum}\` using Bot +${checkerNum}...`, { parse_mode: 'Markdown' });

        try {
            // 2. CHECK: Is it on WhatsApp?
            const [waCheck] = await sock.onWhatsApp(jid);
            if (!waCheck || !waCheck.exists) {
                return bot.editMessageText(
                    `**[INTEL REPORT: +${rawNum}]**\n\n` +
                    `**Status:** NOT FOUND / PURGED\n` +
                    `**Details:** This number is completely dead. It is not registered on WhatsApp or was permanently wiped.`, 
                    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
                );
            }

            jid = waCheck.jid; // Use the exact JID WhatsApp returns

            // 3. CHECK: Fetch About/Bio Status & Age Inference
            let aboutText = "Hidden or Blank";
            let aboutDate = "Unknown";
            let accountAge = "Unknown";
            try {
                const statusInfo = await sock.fetchStatus(jid);
                if (statusInfo && statusInfo.status) {
                    aboutText = statusInfo.status;
                    if (statusInfo.setAt) {
                        const dateSet = new Date(statusInfo.setAt);
                        aboutDate = dateSet.toDateString();
                        const diffDays = Math.ceil(Math.abs(new Date() - dateSet) / (1000 * 60 * 60 * 24));
                        accountAge = `At least ${diffDays} days old`;
                    }
                }
            } catch (e) {
                aboutText = "Privacy Restricted / Wiped (Ghost?)";
            }

            // 4. CHECK: Is it a Business Account?
            let isBusiness = false;
            let bizInfo = "";
            try {
                const bizProfile = await sock.getBusinessProfile(jid);
                if (bizProfile) {
                    isBusiness = true;
                    bizInfo = `\n**Business Details:**\n`;
                    if (bizProfile.description) bizInfo += `- Desc: ${bizProfile.description}\n`;
                    if (bizProfile.email) bizInfo += `- Email: ${bizProfile.email}\n`;
                    if (bizProfile.website && bizProfile.website.length > 0) bizInfo += `- Web: ${bizProfile.website[0]}\n`;
                }
            } catch (e) {
                // Fails silently if it's a regular consumer account
            }

            // 5. CHECK: Profile Picture
            let picUrl = null;
            let picStatus = "Available";
            try {
                picUrl = await sock.profilePictureUrl(jid, 'image'); // Try HD first
            } catch (err) {
                try {
                    picUrl = await sock.profilePictureUrl(jid, 'preview'); // Fallback to thumbnail
                } catch (fallbackErr) {
                    const errMsg = fallbackErr.message.toLowerCase();
                    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('not authorized')) {
                        picStatus = "Private (Restricted to Contacts)";
                    } else if (errMsg.includes('404')) {
                        picStatus = "No Profile Picture Set";
                    } else {
                        picStatus = `Error: ${fallbackErr.message}`;
                    }
                }
            }

            // 6. BUILD THE FINAL REPORT
            const report = 
                `**WHATSAPP INTEL REPORT**\n\n` +
                `**Target:** \`+${rawNum}\`\n` +
                `**Account Type:** ${isBusiness ? "WA Business" : "Standard Consumer"}\n` +
                `**Network Status:** Active / Exists\n` +
                `**Estimated Age:** ${accountAge}\n\n` +
                `**About / Bio:**\n_"${aboutText}"_\n` +
                `_Last Updated: ${aboutDate}_\n` +
                bizInfo +
                `\n**Profile Picture:** ${picUrl ? "Found (See attached)" : picStatus}`;

            await bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});

            // 7. DELIVER THE REPORT (With or without picture)
            if (picUrl) {
                try {
                    const imgRes = await fetch(picUrl);
                    if (imgRes.ok) {
                        const buffer = await imgRes.buffer(); // Assumes node-fetch
                        await bot.sendPhoto(chatId, buffer, { caption: report, parse_mode: 'Markdown' });
                    } else {
                        throw new Error("HTTP Buffer Failed");
                    }
                } catch (downloadErr) {
                    await bot.sendMessage(chatId, report + "\n\n_(Image found but failed to download buffer)_", { parse_mode: 'Markdown' });
                }
            } else {
                await bot.sendMessage(chatId, report, { parse_mode: 'Markdown', disable_web_page_preview: true });
            }

        } catch (error) {
            bot.editMessageText(`**[CRITICAL ERROR]** Recon failed: ${error.message}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
        }
    });


 bot.onText(/\/convt/, async (msg) => {
    deleteUserCommand(bot, msg);
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    const isUserAdmin = (userId === ADMIN_ID);
    const isSubAdmin = SUBADMIN_IDS && SUBADMIN_IDS.includes(userId);
    if (!isUserAdmin && !isSubAdmin) return;

    if (!msg.reply_to_message || !msg.reply_to_message.document) {
        return bot.sendMessage(chatId, "[ERROR] You must reply to a .txt or .xlsx file with /convt");
    }

    const fileId = msg.reply_to_message.document.file_id;
    const fileName = msg.reply_to_message.document.file_name.toLowerCase();
    
    if (!fileName.endsWith('.txt') && !fileName.endsWith('.xlsx')) {
        return bot.sendMessage(chatId, "[ERROR] Only .txt and .xlsx files are supported.");
    }

    userState[chatId + '_convt_file'] = { id: fileId, name: fileName };

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Sort by Country Code (Standard)", callback_data: "convt_sort_cc" }],
                [{ text: "Sort by 'Range' Column (Excel)", callback_data: "convt_sort_rng" }]
            ]
        }
    };
    bot.sendMessage(chatId, "How do you want to group the extracted numbers?", opts);
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
            const onlineCount = Object.keys(clients).length;
            const dbTotal = await countNumbers();

            // Fetch today's stats from the database
            const todayStats = await getTodayStats(); 
            const totalSms = todayStats.total || 0;

            // Build the per-group breakdown text
            let groupBreakdown = "";
            
            // Define all sources (Telegram + Custom API)
            const sources = [
                { id: "-1003518737176", name: "Main Group" },
                { id: "-1003644661262", name: "Gina Group" },
                { id: "Vipotpgrup2", name: "VIP Group" },
                { id: "EDEN_API", name: "Eden API" } // <-- API Added here
            ];
            
            sources.forEach(src => {
                const count = todayStats.groups[src.id] || 0;
                groupBreakdown += `┃ ❃ **${src.name}:** ${count} SMS\n`;
            });

            const text = 
                `╭═══ 𝚂𝚈𝚂𝚃𝙴𝙼 𝚂𝚃𝙰𝚃𝚂 ════⊷\n` +
                `┃ ❃ **Online Bots:** ${onlineCount}\n` +
                `┃ ❃ **DB Numbers:** ${dbTotal}\n` +
                `┃ ❃ **Today's SMS:** ${totalSms}\n` +
                `┣━━━━━━━━━━━━━━━━\n` +
                `┃ ❃ **Today's Breakdown:**\n` +
                groupBreakdown +
                `╰═════════════════⊷`;

            sendMenu(bot, msg.chat.id, text);
        } catch (e) {
            bot.sendMessage(msg.chat.id, '[ERROR] Stats failed: ' + e.message);
        }
    });


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


    // --- /vt command: Vietnam Number Analyzer and Sorter (Refined) ---
    bot.onText(/\/vt/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file with /vt");
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only analyze .txt files.");
        }

        let statusMsg = await bot.sendMessage(chatId, "[SYSTEM] Downloading and analyzing Vietnam prefixes...");

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const textData = await response.text();

            // Extract all digit strings
            const rawMatches = textData.match(/\d{9,15}/g) || [];
            if (rawMatches.length === 0) {
                return bot.editMessageText("[ERROR] No valid numerical data found in the file.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            const uniqueRaw = [...new Set(rawMatches)];
            
            // Buckets for Vietnam prefixes
            const vnBuckets = {
                '03': [], // Viettel
                '05': [], // Vietnamobile / Gmobile
                '07': [], // Mobifone
                '08': [], // Vinaphone / Viettel / ITelecom
                '09': []  // Classic Mobile
            };

            let totalValid = 0;

            // Strict Validation & Sorting Loop
            for (const raw of uniqueRaw) {
                let clean = raw.replace(/\D/g, '');
                
                // Strip country code and leading zeros to normalize down to the core 9 digits
                if (clean.startsWith('84')) clean = clean.substring(2);
                if (clean.startsWith('0')) clean = clean.substring(1);

                if (clean.length === 9 && /^[35789]/.test(clean)) {
                    const prefix = '0' + clean.charAt(0);
                    
                    // We only store the 9-digit core right now. We format it later based on user choice.
                    if (vnBuckets[prefix]) {
                        vnBuckets[prefix].push(clean);
                        totalValid++;
                    }
                }
            }

            if (totalValid === 0) {
                return bot.editMessageText("[REPORT] Scan complete. Found 0 valid Vietnam mobile numbers in this file.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            // --- WIZARD STEP 1: Prefix Selection ---
            let statsText = `[VIETNAM DATA REPORT]\n\nTotal Valid VN Numbers: ${totalValid}\n\nBreakdown by Prefix:\n`;
            let prefixButtons = [];

            for (const [prefix, nums] of Object.entries(vnBuckets)) {
                if (nums.length > 0) {
                    statsText += `- Prefix ${prefix}: ${nums.length} numbers\n`;
                    prefixButtons.push({ text: `Extract ${prefix} Only (${nums.length})`, callback_data: `vt_prefix_${prefix}` });
                }
            }
            statsText += `\nWhich data segment would you like to extract?`;

            const keyboardRows = [];
            for (let i = 0; i < prefixButtons.length; i += 2) {
                keyboardRows.push(prefixButtons.slice(i, i + 2));
            }
            keyboardRows.push([{ text: `Extract ALL Valid Numbers (${totalValid})`, callback_data: "vt_prefix_all" }]);

            const selectedPrefix = await new Promise((resolve) => {
                let isResolved = false;
                
                bot.editMessageText(statsText, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: { inline_keyboard: keyboardRows }
                }).then(() => {
                    const listener = (query) => {
                        if (query.message.message_id === statusMsg.message_id && query.data.startsWith('vt_prefix_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            resolve(query.data.replace('vt_prefix_', ''));
                        }
                    };
                    bot.on('callback_query', listener);
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve(null); } }, 60000);
                });
            });

            if (!selectedPrefix) {
                return bot.editMessageText("[TIMEOUT] You did not select a prefix in time. Command aborted.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            let coreNumbersArray = [];
            let segmentName = "";
            if (selectedPrefix === 'all') {
                for (const nums of Object.values(vnBuckets)) coreNumbersArray.push(...nums);
                segmentName = "All Valid VN Numbers";
            } else {
                coreNumbersArray = vnBuckets[selectedPrefix];
                segmentName = `Prefix ${selectedPrefix}`;
            }

            // --- WIZARD STEP 2: Format Selection ---
            const formatMode = await new Promise((resolve) => {
                let isResolved = false;
                bot.editMessageText(`[FORMAT SELECTION]\nTarget: ${segmentName}\nCount: ${coreNumbersArray.length}\n\nHow should the numbers be formatted?`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Include Country Code (84...)", callback_data: "vt_fmt_84" }],
                            [{ text: "Local Format (0...)", callback_data: "vt_fmt_0" }]
                        ]
                    }
                }).then(() => {
                    const listener = (query) => {
                        if (query.message.message_id === statusMsg.message_id && query.data.startsWith('vt_fmt_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            resolve(query.data.replace('vt_fmt_', ''));
                        }
                    };
                    bot.on('callback_query', listener);
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve('84'); } }, 60000);
                });
            });

            // Apply the chosen formatting rule to the entire array
            const finalArray = coreNumbersArray.map(num => formatMode === '84' ? `84${num}` : `0${num}`);

            // --- WIZARD STEP 3: Output Mode Selection ---
            const outputMode = await new Promise((resolve) => {
                let isResolved = false;
                bot.editMessageText(`[OUTPUT SELECTION]\nTarget: ${segmentName}\nCount: ${finalArray.length}\nFormat: ${formatMode === '84' ? '+84' : 'Local 0'}\n\nHow would you like to receive the output?`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Send as .txt File", callback_data: "vt_out_file" }],
                            [{ text: "Send in Chat (Batches)", callback_data: "vt_out_chat" }]
                        ]
                    }
                }).then(() => {
                    const listener = (query) => {
                        if (query.message.message_id === statusMsg.message_id && query.data.startsWith('vt_out_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            resolve(query.data === 'vt_out_file' ? 'file' : 'chat');
                        }
                    };
                    bot.on('callback_query', listener);
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve('chat'); } }, 60000);
                });
            });

            // Clean up the prompt message
            try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}

            // --- FINAL DELIVERY ---
            if (outputMode === 'chat') {
                bot.sendMessage(chatId, `[DELIVERY] ${segmentName}\nFormat: ${formatMode === '84' ? 'Country Code Included' : 'Local Format'}\nSending in batches of 10...`);
                for (let i = 0; i < finalArray.length; i += 10) {
                    const chunk = finalArray.slice(i, i + 10);
                    const msgText = chunk.map(n => `\`${n}\``).join('\n');
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                    await new Promise(r => setTimeout(r, 800)); // Rate limit protection
                }
                bot.sendMessage(chatId, "[SYSTEM] Delivery complete.");
            } else {
                const fileBuffer = Buffer.from(finalArray.join('\n'));
                await bot.sendDocument(
                    chatId, 
                    fileBuffer, 
                    { caption: `[DELIVERY COMPLETE]\nSegment: ${segmentName}\nTotal: ${finalArray.length}` }, 
                    { filename: `Ultar_Sync_VN_${segmentName.replace(/\s/g, '_')}_${Date.now()}.txt`, contentType: 'text/plain' }
                );
            }

        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "[ERROR] Analysis failed: " + error.message);
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


       // --- /getnum : Smart h2iotp2bot Extractor with Live WA Verification & Progress ---
    bot.onText(/\/getnum\s+(\d+)/i, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;
        
        const countLimit = parseInt(match[1]);
        const targetBot = "h2iotp2bot";

        // 1. Ensure we have an active WA bot to verify the numbers
        const activeFolders = Object.keys(clients).filter(f => clients[f]);
        if (activeFolders.length === 0) {
            return bot.sendMessage(chatId, "[ERROR] No WhatsApp bots connected. I need an active WA connection to verify the numbers.");
        }
        const sock = clients[activeFolders[0]];

        try {
            // 2. Ask user for Output Format using a Promise and Inline Keyboard
            const outputMode = await new Promise((resolve) => {
                let isResolved = false;
                const opts = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Send as .txt File", callback_data: "getnum_file" }],
                            [{ text: "Send in Chat (Batches)", callback_data: "getnum_chat" }]
                        ]
                    }
                };
                
                bot.sendMessage(chatId, `[SETUP] Target: ${countLimit} numbers.\nHow would you like to receive the output?`, opts).then(promptMsg => {
                    const listener = (query) => {
                        if (query.message.message_id === promptMsg.message_id) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            bot.deleteMessage(chatId, promptMsg.message_id).catch(()=>{});
                            resolve(query.data === 'getnum_file' ? 'file' : 'chat');
                        }
                    };
                    bot.on('callback_query', listener);
                    
                    // Default to chat if no selection is made within 60 seconds
                    setTimeout(() => {
                        if (!isResolved) {
                            bot.removeListener('callback_query', listener);
                            bot.deleteMessage(chatId, promptMsg.message_id).catch(()=>{});
                            resolve('chat'); 
                        }
                    }, 60000);
                });
            });

            // 3. Connect the dedicated GETNUM Telegram account
            await ensureGetnumConnected(); 

            // 4. Send /start to trigger the target bot
            await getnumUserBot.sendMessage(targetBot, { message: "/start" }); 

            let statusMsg = await bot.sendMessage(chatId, `[SENT] /start to @${targetBot}.\n\nPlease go to @${targetBot} on your GETNUM account now and select your country.\nI am waiting for the numbers to appear...`, { parse_mode: 'Markdown' });

            let countrySelected = false;
            let attempts = 0;
            let targetMessage = null;

            // Wait for the user to pick a country
            while (!countrySelected && attempts < 60) { 
                const res = await getnumUserBot.getMessages(targetBot, { limit: 1 }); 
                const currentMsg = res[0];

                if (currentMsg && currentMsg.replyMarkup && currentMsg.replyMarkup.rows) {
                    for (const row of currentMsg.replyMarkup.rows) {
                        for (const b of row.buttons) {
                            if ((b.text || "").toLowerCase().includes("change numbers")) {
                                countrySelected = true;
                                targetMessage = currentMsg;
                                break;
                            }
                        }
                    }
                }

                if (!countrySelected) {
                    await delay(2000);
                    attempts++;
                }
            }

            if (!countrySelected) {
                return bot.editMessageText(`[TIMEOUT] You didn't select a country in time. Try /getnum again.`, { chat_id: chatId, message_id: statusMsg.message_id });
            }

            let totalChecked = 0;
            let totalVerified = 0;
            let seenNumbers = [];
            let currentBatch = [];
            let allValidNumbers = []; // Used if outputMode is 'file'
            let noNewNumsCount = 0;

            const updateProgress = async () => {
                const text = `[SCRAPING IN PROGRESS]\n\nTarget: ${countLimit}\nExtracted from Bot: ${totalChecked}\nVerified on WhatsApp: ${totalVerified}\n\nRunning anti-ban delay protocols...`;
                try {
                    await bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
                } catch (e) { /* Ignore identical message edit errors */ }
            };

            await updateProgress();

            // 5. Extraction and Verification Loop
            while (totalVerified < countLimit) {
                const text = targetMessage.message || "";
                
                const rawMatches = text.match(/\+\d{1,4}\s?\d{7,14}/g) || [];
                let newNumsFoundInLoop = false;

                for (const raw of rawMatches) {
                    if (totalVerified >= countLimit) break;

                    const cleanNum = raw.replace(/\D/g, ''); 
                    
                    if (seenNumbers.includes(cleanNum)) continue; 
                    
                    seenNumbers.push(cleanNum); 
                    newNumsFoundInLoop = true;
                    totalChecked++;

                    const res = normalizeWithCountry(cleanNum);
                    if (!res || !res.num) continue;
                    
                    const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                    const jid = `${fullPhone}@s.whatsapp.net`;

                    // --- LIVE WHATSAPP CHECK ---
                    try {
                        const [waCheck] = await sock.onWhatsApp(jid);
                        if (waCheck && waCheck.exists) {
                            totalVerified++;
                            
                            if (outputMode === 'chat') {
                                currentBatch.push(`\`${res.num}\``);
                                if (currentBatch.length >= 5) {
                                    await bot.sendMessage(chatId, `[BATCH]\n${currentBatch.join('\n')}`, { parse_mode: 'Markdown' });
                                    currentBatch = [];
                                }
                            } else {
                                // outputMode === 'file'
                                allValidNumbers.push(res.num);
                            }
                        }
                    } catch (e) {
                        console.error("WA Check Error:", e.message);
                    }
                    
                    // Update the progress dashboard every 2 numbers checked
                    if (totalChecked % 2 === 0) {
                        await updateProgress();
                    }

                    // CRITICAL ANTI-BAN DELAY
                    await delay(3000); 
                }

                if (totalVerified >= countLimit) break;

                // Failsafe if the bot runs out of stock
                // 6. Click "Change Numbers"
                let clicked = false;
                if (targetMessage.replyMarkup && targetMessage.replyMarkup.rows) {
                    for (let r = 0; r < targetMessage.replyMarkup.rows.length; r++) {
                        const row = targetMessage.replyMarkup.rows[r];
                        for (let c = 0; c < row.buttons.length; c++) {
                            const btnText = row.buttons[c].text || "";
                            if (btnText.toLowerCase().includes("change numbers")) {
                                await targetMessage.click(r, c);
                                clicked = true;
                                break;
                            }
                        }
                        if (clicked) break;
                    }
                }

                if (clicked) {
                    await delay(4000); // Wait for the target bot to edit the list
                    
                    // UPGRADE: Fetch the last 10 messages and ignore the OTP spam
                    const res = await getnumUserBot.getMessages(targetBot, { limit: 10 });
                    let foundMenu = false;

                    for (const msg of res) {
                        if (msg.replyMarkup && msg.replyMarkup.rows) {
                            for (const row of msg.replyMarkup.rows) {
                                for (const b of row.buttons) {
                                    if ((b.text || "").toLowerCase().includes("change numbers")) {
                                        targetMessage = msg;
                                        foundMenu = true;
                                        break;
                                    }
                                }
                                if (foundMenu) break;
                            }
                        }
                        if (foundMenu) break;
                    }

                    if (!foundMenu) {
                        await bot.sendMessage(chatId, "[ERROR] Scanned the last 10 messages but could not find the 'Change Numbers' button. Stopping.", { parse_mode: 'Markdown' });
                        break;
                    }
                    
                } else {
                    await bot.sendMessage(chatId, "[ERROR] Could not click the 'Change Numbers' button. Stopping.", { parse_mode: 'Markdown' });
                    break;
                }

            }

            // Final Output Delivery
            try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}
            
            if (outputMode === 'chat' && currentBatch.length > 0) {
                await bot.sendMessage(chatId, `[BATCH - FINAL]\n${currentBatch.join('\n')}`, { parse_mode: 'Markdown' });
            } else if (outputMode === 'file' && allValidNumbers.length > 0) {
                const fileBuffer = Buffer.from(allValidNumbers.join('\n'));
                await bot.sendDocument(
                    chatId, 
                    fileBuffer, 
                    { caption: `[PROCESS COMPLETE]\nSuccessfully extracted and verified ${totalVerified} active WhatsApp numbers.`, parse_mode: 'Markdown' }, 
                    { filename: `Extracted_WA_Numbers_${Date.now()}.txt`, contentType: 'text/plain' }
                );
            }

            if (outputMode === 'chat') {
                bot.sendMessage(chatId, `[PROCESS COMPLETE]\nSuccessfully extracted and verified ${totalVerified} active WhatsApp numbers.`, { parse_mode: 'Markdown' });
            }

        } catch (err) {
            bot.sendMessage(chatId, "[ERROR] " + err.message);
        }
    });
 


     // --- /channel [Country]: Forward File to TG Channel & WA Group + Auto-Delete ---
    bot.onText(/\/channel(?:\s+(.+))?/i, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt or .xlsx file with /channel [CountryName]\nExample: /channel Vietnam");
        }

        const doc = msg.reply_to_message.document;
        const fileName = doc.file_name.toLowerCase();
        
        if (!fileName.endsWith('.txt') && !fileName.endsWith('.xlsx')) {
            return bot.sendMessage(chatId, "[ERROR] I can only process and count .txt or .xlsx files.");
        }

        const countryName = match[1] ? match[1].trim() : "Unknown Region";
        
        // --- CONFIGURATION ---
        const targetChannelId = "-1003844497723"; // Your hardcoded Channel ID
        const otpGroupLink = "https://t.me/+MLS1oZxY6TtiMTQ1"; // Replace with your Tap-to-Join link
        const waGroupId = process.env.WA_TARGET_GROUP || "1234567890-123456@g.us"; // WhatsApp Group JID

        let statusMsg = await bot.sendMessage(chatId, `[PROCESSING] Scanning ${doc.file_name} to count numbers...`);

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const buffer = await response.arrayBuffer(); 
            const nodeBuffer = Buffer.from(buffer);
            
            let totalNumbers = 0;

            // Count logic
            if (fileName.endsWith('.txt')) {
                const textData = nodeBuffer.toString('utf-8');
                const matches = textData.match(/\d{8,15}/g) || [];
                totalNumbers = matches.length;
            } else if (fileName.endsWith('.xlsx')) {
                try {
                    const XLSX = require('xlsx'); 
                    const workbook = XLSX.read(nodeBuffer, { type: 'buffer' });
                    const sheetName = workbook.SheetNames[0];
                    const sheet = workbook.Sheets[sheetName];
                    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                    
                    const flatData = data.flat().join(' ');
                    const matches = flatData.match(/\d{8,15}/g) || [];
                    totalNumbers = matches.length;
                } catch (err) {
                    return bot.editMessageText("[ERROR] Failed to parse .xlsx file. Did you run 'npm install xlsx'?", { chat_id: chatId, message_id: statusMsg.message_id });
                }
            }

            // --- 1. POST TO TELEGRAM CHANNEL ---
            const captionText = `Country: ${countryName}\nTotal Numbers: ${totalNumbers}\n\n[OTP Group](${otpGroupLink})`;

            await bot.sendDocument(targetChannelId, doc.file_id, {
                caption: captionText,
                parse_mode: 'Markdown'
            });

            // --- 2. POST TO WHATSAPP GROUP & REPLY ---
            let waStatus = "Skipped (No WA bot connected)";
            const activeFolders = Object.keys(clients).filter(f => clients[f]);
            
            if (activeFolders.length > 0) {
                const sock = clients[activeFolders[0]]; 
                
                try {
                    const mimeType = fileName.endsWith('.xlsx') 
                        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
                        : 'text/plain';

                    // Send the document to WhatsApp
                    const waDocMsg = await sock.sendMessage(waGroupId, {
                        document: nodeBuffer,
                        mimetype: mimeType,
                        fileName: doc.file_name,
                        caption: `Country: ${countryName} | ${totalNumbers} Numbers`
                    });

                    // Wait 2 seconds, then reply with .tag
                    await delay(2000);
                    const tagMsg = await sock.sendMessage(waGroupId, {
                        text: ".tag"
                    }, { quoted: waDocMsg });

                    waStatus = "Success (Auto-deleting in 30s)";

                    // Background Timer for Deletion
                    setTimeout(async () => {
                        try {
                            // Delete the .tag message first
                            await sock.sendMessage(waGroupId, { delete: tagMsg.key });
                            
                            // Wait 1 second to prevent WhatsApp from rejecting rapid requests
                            await delay(1000); 
                            
                            // Delete the document message
                            await sock.sendMessage(waGroupId, { delete: waDocMsg.key });
                        } catch (delErr) {
                            console.error("WA Deletion Error:", delErr.message);
                        }
                    }, 30000); // 30 seconds

                } catch (waErr) {
                    console.error("WA Send Error:", waErr);
                    waStatus = "Failed";
                }
            }

            bot.editMessageText(`[SUCCESS] Distribution Complete!\n\nTarget: ${countryName}\nCount: ${totalNumbers}\nTG Channel: Success\nWA Group: ${waStatus}`, { chat_id: chatId, message_id: statusMsg.message_id });

        } catch (error) {
            console.error("Distribution Error:", error);
            bot.editMessageText(`[ERROR] Process failed: ${error.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
        }
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



                // --- /addspy: Load numbers into the silent tripwire memory (Appends to existing) ---
    bot.onText(/\/addspy/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file with /addspy");
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only load .txt files into spy memory.");
        }

        try {
            let statusMsg = await bot.sendMessage(chatId, "[SYSTEM] Loading file into Spy Memory...");

            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const textData = await response.text();

            const matches = textData.match(/\d{7,15}/g) || [];
            if (matches.length === 0) {
                return bot.editMessageText("[ERROR] No valid numbers found.", { chat_id: chatId, message_id: statusMsg.message_id });
            }

            let addedCount = 0;
            
            // NOTE: spyMemory.clear() is completely removed so multiple files stack in RAM
            for (const rawNum of matches) {
                const res = normalizeWithCountry(rawNum);
                if (res && res.num) {
                    const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                    
                    if (!spyMemory.has(fullPhone)) {
                        spyMemory.add(fullPhone);
                        addedCount++;
                    }
                }
            }

            bot.editMessageText(`[SPY MODE ACTIVE]\n\nAdded ${addedCount} new numbers from this file.\nTotal numbers currently in RAM: ${spyMemory.size}\n\nListening for matches in the OTP group...`, { chat_id: chatId, message_id: statusMsg.message_id });

        } catch (err) {
            bot.sendMessage(chatId, "[ERROR] " + err.message);
        }
    });


            // --- /addspy: Load active WA numbers into the silent tripwire memory (Appends to existing memory) ---
        // --- /spynum: Retrieve caught numbers and reset the trap ---
    bot.onText(/\/spynum/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        if (spyFound.size === 0) {
            return bot.sendMessage(chatId, "[SPY REPORT] No matches found yet. The trap is still listening.");
        }

        const foundArray = Array.from(spyFound);
        
        bot.sendMessage(chatId, `[SPY REPORT] Caught ${foundArray.length} numbers!\n\nSending in batches of 5...`);

        // Process numbers to strip the country codes for clean output
        const strippedArray = foundArray.map(rawNum => {
            const res = normalizeWithCountry(rawNum);
            // If the normalizer recognizes it, return the local number without the country code.
            return (res && res.num) ? res.num : rawNum;
        });

        // Send in smaller batches of 5
        for (let i = 0; i < strippedArray.length; i += 5) {
            const chunk = strippedArray.slice(i, i + 5);
            const msgText = chunk.map(n => `\`${n}\``).join('\n');
            await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        bot.sendMessage(chatId, "[SYSTEM] Caught numbers cleared. The background listener is still active.");
        
        // Reset the caught list, but keep the original memory active
        spyFound.clear();
    });



    // --- /dspy: Delete all numbers stored in the spy memory ---
    bot.onText(/\/dspy/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        const previousSize = spyMemory.size;

        spyMemory.clear();
        spyFound.clear();

        bot.sendMessage(chatId, `[SYSTEM] Spy memory wiped.\n\nDeleted ${previousSize} numbers from RAM. The background listener is now idle.`, { parse_mode: 'Markdown' });
    });


            // --- /bulkpic command: Scrape, Compress, and Watermark HD Profile Pics ---
    bot.onText(/\/bulkpic/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;
        
        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt file containing the numbers with /bulkpic", { parse_mode: 'Markdown' });
        }

        const doc = msg.reply_to_message.document;
        if (!doc.file_name.endsWith('.txt')) {
            return bot.sendMessage(chatId, "[ERROR] I can only process .txt files for this command.");
        }

        const firstId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!firstId) return bot.sendMessage(chatId, '[ERROR] No WhatsApp accounts connected.');
        const sock = clients[shortIdMap[firstId].folder];

        const targetChannel = "-1003735392339"; 

        try {
            let statusMsg = await bot.sendMessage(chatId, "[SYSTEM] Downloading file and extracting numbers...", { parse_mode: 'Markdown' });

            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const textData = await response.text();

            const matches = textData.match(/\d{7,15}/g) || [];
            if (matches.length === 0) return bot.editMessageText("[ERROR] No valid numbers found in the file.", { chat_id: chatId, message_id: statusMsg.message_id });

            const uniqueNumbers = [...new Set(matches)];
            
            await bot.editMessageText(`[SYSTEM] Found ${uniqueNumbers.length} unique numbers.\n\nStarting the HD Profile Scraping engine. Watermarking and compression are active.`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

            let successCount = 0;
            let noPicCount = 0;
            let failCount = 0;
            
            // Dual-Album System
            let adminAlbum = [];   // For you (with numbers)
            let channelAlbum = []; // For the channel (photos only)

            for (let i = 0; i < uniqueNumbers.length; i++) {
                const rawNum = uniqueNumbers[i];
                
                const res = normalizeWithCountry(rawNum);
                const fullPhone = res && res.num ? (res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`) : rawNum;
                const jid = `${fullPhone}@s.whatsapp.net`;

                try {
                    let picUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
                    
                    if (!picUrl) {
                        picUrl = await sock.profilePictureUrl(jid, 'preview').catch(() => null);
                    }

                    if (picUrl) {
                        const imgRes = await fetch(picUrl);
                        if (imgRes.ok) {
                            const rawBuffer = await imgRes.buffer();
                            
                            // --- COMPRESSION AND WATERMARKING ---
                            const processedBuffer = await sharp(rawBuffer)
                                .resize(640, 640, { fit: 'inside', withoutEnlargement: true }) // Standardize size
                                .composite([{
                                    input: Buffer.from(`
                                        <svg width="640" height="100">
                                            <text x="620" y="80" text-anchor="end" font-size="42" fill="rgba(255, 255, 255, 0.8)" font-weight="bold" stroke="rgba(0, 0, 0, 0.8)" stroke-width="3" font-family="Arial">𝖀𝖑𝖙-𝕬𝕽</text>
                                        </svg>
                                    `),
                                    gravity: 'southeast',
                                    blend: 'over'
                                }])
                                .jpeg({ quality: 75 }) // Compress to save RAM and upload speed
                                .toBuffer();
                            
                            // Admin view gets the phone number
                            adminAlbum.push({
                                type: 'photo',
                                media: processedBuffer,
                                caption: `+${fullPhone}`
                            });
                            
                            // Channel view gets absolutely nothing but the picture
                            channelAlbum.push({
                                type: 'photo',
                                media: processedBuffer
                            });

                            successCount++;
                        } else {
                            failCount++;
                        }
                    } else {
                        noPicCount++; 
                    }
                } catch (err) {
                    failCount++;
                }

                // Live Progress Updater
                if ((i + 1) % 5 === 0 || i === uniqueNumbers.length - 1) {
                    const percent = Math.floor(((i + 1) / uniqueNumbers.length) * 100);
                    const progressText = 
                        `[SCRAPING IN PROGRESS] ${percent}%\n\n` +
                        `Processed: ${i + 1} / ${uniqueNumbers.length}\n` +
                        `Found HD: ${successCount}\n` +
                        `No Pic/Private: ${noPicCount}\n` +
                        `Errors: ${failCount}\n\n` +
                        `Albums are being processed in batches of 10...`;
                    
                    try {
                        await bot.editMessageText(progressText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
                    } catch (editErr) {}
                }

                // Send Batch (Max 10 per album limit on Telegram)
                if (adminAlbum.length === 10 || (i === uniqueNumbers.length - 1 && adminAlbum.length > 0)) {
                    try {
                        await bot.sendMediaGroup(chatId, adminAlbum);
                        
                        if (typeof senderBot !== 'undefined') {
                            await senderBot.sendMediaGroup(targetChannel, channelAlbum).catch(e => console.log("[ERROR] OTP Bot failed to send album:", e.message));
                        }
                    } catch (albumErr) {
                        console.error("Failed to send album batch:", albumErr.message);
                    }
                    adminAlbum = [];
                    channelAlbum = [];
                }

                if (i < uniqueNumbers.length - 1) {
                    const randomDelay = Math.floor(Math.random() * 2000) + 3000;
                    await new Promise(resolve => setTimeout(resolve, randomDelay));
                }
            }

            const finalStats = 
                `[BULK SCRAPE COMPLETE]\n\n` +
                `Stats for ${doc.file_name}:\n` +
                `Total Checked: ${uniqueNumbers.length}\n` +
                `Found HD Pics: ${successCount}\n` +
                `No Pic / Private: ${noPicCount}\n` +
                `Failed/Errors: ${failCount}\n\n` +
                `Albums delivered.`;

            try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) {}
            bot.sendMessage(chatId, finalStats, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "[CRITICAL ERROR] During bulk scan: " + error.message, { parse_mode: 'Markdown' });
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


        // --- /addgrp [@username] : Force-add or Auto-DM an invite link using UserBot ---
    bot.onText(/\/addgrp\s+(.+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        // Authorization check
        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        let targetUser = match[1].trim();
        
        // Ensure the @ symbol is there for GramJS to resolve it properly
        if (!targetUser.startsWith('@') && isNaN(targetUser)) {
            targetUser = '@' + targetUser;
        }

        // --- CONFIGURATION ---
        const TARGET_GROUP = "-1003645249777"; // Your ULTAR_OTP_GROUP_ID
        const INVITE_LINK = "https://t.me/+MLS1oZxY6TtiMTQ1"; // Put your actual tap-to-join link here

        if (!userBot || !userBot.connected) {
            return bot.sendMessage(chatId, "[ERROR] UserBot is not connected. I need the UserBot active to execute this.");
        }

        let statusMsg = await bot.sendMessage(chatId, `Attempting to force-add ${targetUser}...`);

        try {
            // STEP 1: Try to force-add them silently
            await userBot.invoke(new Api.channels.InviteToChannel({
                channel: TARGET_GROUP,
                users: [targetUser]
            }));

            bot.editMessageText(`**[SUCCESS]**\nSuccessfully added ${targetUser} directly to the group!`, { 
                chat_id: chatId, 
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });

        } catch (e) {
            let errorText = e.message;
            
            // If they are already in the group, stop immediately.
            if (errorText.includes("USER_ALREADY_PARTICIPANT")) {
                return bot.editMessageText(`${targetUser} is already inside the group.`, { chat_id: chatId, message_id: statusMsg.message_id });
            } else if (errorText.includes("USERNAME_INVALID") || errorText.includes("ResolveUsername")) {
                return bot.editMessageText(`**[ERROR]** This username does not exist on Telegram.`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
            }

            // STEP 2: The Fallback Protocol (Direct Message)
            try {
                await bot.editMessageText(`**[BLOCKED]** Privacy settings prevented the direct add.\n\nAttempting to send the invite link directly to their DM...`, { 
                    chat_id: chatId, 
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown'
                });

                // Send the DM using the UserBot
                const dmMessage = await userBot.sendMessage(targetUser, {
                    message: `Hello! You have been invited to join our group. Click the link below to enter:\n\n${INVITE_LINK}\n\n_Note: This invite link will expire and be deleted in 24 hours._`
                });

                await bot.editMessageText(`**[DM SENT]**\nCould not force-add, but successfully dropped the invite link into ${targetUser}'s DMs!\n\n🕒 The message will self-destruct in exactly 24 hours.`, { 
                    chat_id: chatId, 
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown'
                });

                // STEP 3: The 24-Hour Kill Timer
                // 86,400,000 milliseconds = exactly 24 hours
                setTimeout(async () => {
                    try {
                        // 'revoke: true' ensures the message is deleted for BOTH people in the DM
                        await userBot.deleteMessages(targetUser, [dmMessage.id], { revoke: true });
                        console.log(`[SYSTEM] Auto-deleted the 24h invite link sent to ${targetUser}`);
                    } catch (delErr) {
                        console.error("Failed to auto-delete DM:", delErr.message);
                    }
                }, 86400000);

            } catch (dmErr) {
                // If the DM fails, it usually means the target user has blocked the UserBot account
                bot.editMessageText(`**[FATAL ERROR]**\nCould not force-add AND could not send a DM to ${targetUser}.\n\nReason: _${dmErr.message}_\n(They may have blocked the account or have absolute privacy enabled).`, { 
                    chat_id: chatId, 
                    message_id: statusMsg.message_id,
                    parse_mode: 'Markdown'
                });
            }
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


            // --- /tcheck : Ultimate Deep Scan (Active, Clean, Temp Ban, Perm Ban) ---
    bot.onText(/\/tcheck/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = (SUBADMIN_IDS || []).includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .xlsx file with /tcheck\n\n*Warning:* This is a deep scan and runs slowly to protect your bot from being banned.');
        }

        const activeFolders = Object.keys(clients).filter(f => clients[f] && f !== currentOtpSenderId);
        if (activeFolders.length === 0) return bot.sendMessage(chatId, '[ERROR] No active bots available for deep checking.');
        
        const sock = clients[activeFolders[0]];
        const checkerNum = sock.user.id.split(':')[0]; 

        try {
            const statusMsg = await bot.sendMessage(chatId, `[DEEP SCAN INITIATED]\nUsing Bot: +${checkerNum}\nDownloading file...`);
            
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let rawNumbers = [];

            if (fileName.toLowerCase().endsWith('.xlsx')) {
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

            const activeList = [];       // Registered on another phone (Your image)
            const cleanList = [];        // Exists: false, but not banned
            const tempBanList = [];      // Reason: Blocked (Reviewable)
            const permBanList = [];      // Reason: Banned
            const invalidList = [];      // Format errors
            
            let processed = 0;
            userState[chatId + '_stopFlag'] = false;

            for (const numStr of rawNumbers) {
                if (userState[chatId + '_stopFlag']) break;

                const res = normalizeWithCountry(numStr);
                if (!res || !res.num) continue;

                const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                const jid = `${fullPhone}@s.whatsapp.net`;

                try {
                    // STEP 1: Passive Check (Identifies Active Accounts)
                    const [waCheck] = await sock.onWhatsApp(jid);
                    
                    if (waCheck && waCheck.exists) {
                        activeList.push(res.num); // Registered on another device
                    } else {
                        // STEP 2: Aggressive Ban Probe
                        try {
                            await sock.requestRegistrationCode({
                                phoneNumber: "+" + fullPhone,
                                method: 'sms',
                                fields: {
                                    mcc: "624", 
                                    mnc: "01"
                                }
                            });
                            // If this payload succeeds without an error, the number is clean and unregistered.
                            cleanList.push(res.num);
                        } catch (regErr) {
                            const reason = regErr.data?.reason || regErr.message || "unknown";
                            
                            if (reason === 'blocked') {
                                tempBanList.push(res.num);
                            } else if (reason === 'banned') {
                                permBanList.push(res.num);
                            } else {
                                invalidList.push(res.num);
                            }
                        }
                    }
                } catch (e) {
                    invalidList.push(res.num);
                }

                processed++;
                
                // Live Update every 10 numbers
                if (processed % 10 === 0 && !userState[chatId + '_stopFlag']) {
                    try {
                        await bot.editMessageText(
                            `[DEEP SCAN IN PROGRESS]\n\n` +
                            `Checked: ${processed} / ${rawNumbers.length}\n` +
                            `Active (Logged In): ${activeList.length}\n` +
                            `Clean (Unregistered): ${cleanList.length}\n` +
                            `Temp Ban: ${tempBanList.length}\n` +
                            `Perm Ban: ${permBanList.length}`,
                            { chat_id: chatId, message_id: statusMsg.message_id }
                        );
                    } catch(e) {}
                }
                
                // MANDATORY ANTI-BAN DELAY (4 Seconds)
                // Do not lower this, or your checker bot will be permanently banned.
                await delay(4000); 
            }

            const isAborted = userState[chatId + '_stopFlag'];
            userState[chatId + '_stopFlag'] = false;
            try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch(e) {}

            let finalCaption = isAborted ? `[DEEP SCAN ABORTED]\n\n` : `[DEEP SCAN COMPLETE]\n\n`;
            finalCaption += `Total Checked: ${processed}\n`;
            finalCaption += `Active (Logged In): ${activeList.length}\n`;
            finalCaption += `Clean (Unregistered): ${cleanList.length}\n`;
            finalCaption += `Temp Ban (Reviewable): ${tempBanList.length}\n`;
            finalCaption += `Permanent Ban: ${permBanList.length}\n`;
            finalCaption += `Invalid/Errors: ${invalidList.length}`;

            // Send Results as an Album if there are files
            const filesToSend = [];
            const tempDir = `./tmp_tcheck_${Date.now()}_${chatId}`;
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

            if (activeList.length > 0) {
                const path = `${tempDir}/Active_Logged_In.txt`;
                fs.writeFileSync(path, activeList.join('\n'));
                filesToSend.push({ type: 'document', media: path });
            }
            if (cleanList.length > 0) {
                const path = `${tempDir}/Clean_Unregistered.txt`;
                fs.writeFileSync(path, cleanList.join('\n'));
                filesToSend.push({ type: 'document', media: path });
            }
            if (tempBanList.length > 0) {
                const path = `${tempDir}/Temporarily_Banned.txt`;
                fs.writeFileSync(path, tempBanList.join('\n'));
                filesToSend.push({ type: 'document', media: path });
            }
            if (permBanList.length > 0) {
                const path = `${tempDir}/Permanently_Banned.txt`;
                fs.writeFileSync(path, permBanList.join('\n'));
                filesToSend.push({ type: 'document', media: path });
            }

            if (filesToSend.length > 0) {
                filesToSend[0].caption = finalCaption; // Attach report to the first file
                filesToSend[0].parse_mode = 'Markdown';
                
                try {
                    await bot.sendMediaGroup(chatId, filesToSend);
                } catch (err) {
                    await bot.sendMessage(chatId, finalCaption, { parse_mode: 'Markdown' });
                }

                // Cleanup
                filesToSend.forEach(f => { if (fs.existsSync(f.media)) fs.unlinkSync(f.media); });
                if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
            } else {
                await bot.sendMessage(chatId, finalCaption, { parse_mode: 'Markdown' });
            }

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] ${e.message}`);
        }
    });


        // --- /del : Delete numbers from PAYME chat and Database ---
    bot.onText(/^\/del(?:\s+([\s\S]+))?/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        // Authorization Check
        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        const rawInput = match[1];
        if (!rawInput) {
            return bot.sendMessage(chatId, "[ERROR] Usage:\n/del\n04163007202\n04261846661");
        }

        // Extract numbers from the multi-line input
        const numbersToDelete = rawInput.split(/\r?\n/).map(n => n.trim().replace(/\D/g, '')).filter(n => n.length >= 7);

        if (numbersToDelete.length === 0) {
            return bot.sendMessage(chatId, "[ERROR] No valid numbers provided.");
        }

        const statusMsg = await bot.sendMessage(chatId, `[SYSTEM] Searching for ${numbersToDelete.length} number(s) to delete...`);

        try {
            await ensurePaymeConnected();
            
            const dbDeleteList = [];
            const searchStrings = [];
            
            // Format numbers for both the Chat Search and the Database Search
            for (let num of numbersToDelete) {
                searchStrings.push(num); // Keep the raw version (e.g., 0416...) to find in the chat
                
                let formattedNum = num;
                // Force Venezuela format for the database check
                if (num.startsWith('041') || num.startsWith('042')) {
                    formattedNum = '58' + num.substring(1);
                } else if ((num.length === 10) && (num.startsWith('41') || num.startsWith('42'))) {
                    formattedNum = '58' + num;
                }
                
                const res = normalizeWithCountry(formattedNum);
                if (res && res.num) {
                    const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                    dbDeleteList.push(fullPhone);
                }
            }

            // Fetch the last 3000 messages from the PAYME bot chat
            const PAYME_CHAT_USERNAME = "paymennow_bot";
            const messages = await paymeUserBot.getMessages(PAYME_CHAT_USERNAME, { limit: 3000 });
            
            const msgIdsToDelete = [];

            // Scan messages for the numbers
            for (const m of messages) {
                if (m.message) {
                    // If the message contains any of our target numbers, flag it for deletion
                    const hasMatch = searchStrings.some(num => m.message.includes(num));
                    if (hasMatch) {
                        msgIdsToDelete.push(m.id);
                    }
                }
            }

            // 1. Delete from Telegram Chat
            let chatDeleted = 0;
            if (msgIdsToDelete.length > 0) {
                await paymeUserBot.deleteMessages(PAYME_CHAT_USERNAME, msgIdsToDelete, { revoke: true });
                chatDeleted = msgIdsToDelete.length;
            }

            // 2. Delete from Database
            let dbDeleted = 0;
            if (dbDeleteList.length > 0) {
                await deleteNumbers(dbDeleteList);
                dbDeleted = dbDeleteList.length;
            }

            bot.editMessageText(
                `[DELETE COMPLETE]\n\n` +
                `Requested: ${numbersToDelete.length}\n` +
                `Deleted from PAYME Chat: ${chatDeleted} messages\n` +
                `Deleted from Database: ${dbDeleted} records`,
                { chat_id: chatId, message_id: statusMsg.message_id }
            );

        } catch (e) {
            bot.editMessageText(`[ERROR] Failed to delete: ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
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

        // --- /profilepic command: Get HD profile picture of any WhatsApp number ---
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

            bot.sendMessage(chatId, '[FETCHING] HD Profile picture for +' + displayNumber + '...');

            let picUrl = null;
            
            try {
                // 🚨 FIX: Pass 'image' to fetch the full High-Definition picture instead of the blurry thumbnail
                picUrl = await sock.profilePictureUrl(targetJid, 'image');
            } catch (picError) {
                // Fallback: If HD fails (sometimes WA servers act up), try the standard preview before quitting
                try {
                    picUrl = await sock.profilePictureUrl(targetJid, 'preview');
                } catch (fallbackError) {
                    // If we get an authorization error, provide privacy info
                    if (fallbackError.message.includes('401') || fallbackError.message.includes('403') || fallbackError.message.includes('not authorized') || picError.message.includes('not authorized')) {
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
                        throw fallbackError;
                    }
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
                    caption: `[HD PROFILE PIC]\nNumber: +${displayNumber}`
                });

                sendMenu(bot, chatId, '[SUCCESS] HD Profile picture sent.');
            } catch (downloadError) {
                bot.sendMessage(chatId, '[ERROR] Failed to download image: ' + downloadError.message);
            }

        } catch (e) {
            // Check if it's a not-found or invalid number error
            if (e.message.includes('404') || e.message.includes('not found')) {
                bot.sendMessage(chatId, '[ERROR] Number not found on WhatsApp (or no profile picture set).');
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

    // --- LISTENER: Delete Message on Admin Reaction (Bulletproof Raw Update) ---
    bot.on('raw_update', async (update) => {
        // Intercept raw reaction payloads directly from Telegram
        if (update.message_reaction) {
            const reaction = update.message_reaction;
            try {
                if (!reaction.chat || !reaction.message_id) return;

                const reactorId = reaction.user ? reaction.user.id.toString().trim() : null;
                if (!reactorId) return;

                const isAdmin = (reactorId === ADMIN_ID.toString().trim());
                const isSubAdmin = (SUBADMIN_IDS || []).includes(reactorId);

                // If an authorized user adds a new reaction, delete the message
                if ((isAdmin || isSubAdmin) && reaction.new_reaction && reaction.new_reaction.length > 0) {
                    await bot.deleteMessage(reaction.chat.id, reaction.message_id);
                }
            } catch (e) {
                // Fails silently if message is already deleted
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

                if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number.');
            
            // CHECK 1: Verify CAPTCHA if not admin/subadmin
            if (userId !== ADMIN_ID && !isSubAdmin) { 
                const dbVerified = await isUserVerified(userId);
                if (!dbVerified) {
                    bot.sendMessage(chatId, '[SECURITY] Please complete CAPTCHA verification first.');
                    userState[chatId] = null;
                    return;
                }
            }
            
            // CHECK 2: Smart Overwrite for Offline Sessions (Fixes the "Already exists" error)
            const existingSession = Object.values(shortIdMap).find(s => s.phone === number);
            if (existingSession) {
                const existingId = Object.keys(shortIdMap).find(k => shortIdMap[k] === existingSession);
                
                // If the bot is currently ONLINE and working, block the new pairing
                if (clients[existingSession.folder]) {
                    return sendMenu(bot, chatId, `[ERROR] Number +${number} is already active and ONLINE as ID: ${existingId}`);
                } else {
                    // If it is OFFLINE, wipe the old memory so the user can re-link immediately
                    bot.sendMessage(chatId, `[SYSTEM] Offline session detected for +${number}. Clearing old data to allow re-linking...`);
                    
                    // Remove from active memory map to bypass the block
                    delete shortIdMap[existingId];
                    
                    // Delete the broken authentication folder from the server to prevent credential conflicts
                    try {
                        if (fs.existsSync(existingSession.folder)) {
                            fs.rmSync(existingSession.folder, { recursive: true, force: true });
                        }
                    } catch (e) {
                        console.error("[CLEANUP ERROR]", e.message);
                    }
                }
            }
            
            userState[chatId] = null;
            bot.sendMessage(chatId, 'Initializing +' + number + '...', getKeyboard(chatId));
            const sessionId = makeSessionId();
            
            // Start the new client
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



                // --- MOBILE API: STEP 1 (Receive Phone Number & Request SMS) ---
        if (userState[chatId] === 'WAITING_MOBILE_NUMBER') {
            const phoneNumber = text.replace(/[^0-9]/g, '');
            if (phoneNumber.length < 10) return bot.sendMessage(chatId, '❌ Invalid number format. Try again.');
            
            userState[chatId] = null; // Clear state
            bot.sendMessage(chatId, `⏳ Requesting WhatsApp SMS code for +${phoneNumber}...`);

            try {
                // NOTE: You must have a function named 'startMobileRegistration' exported from your index.js
                // that initializes the mobile socket and requests the code.
                const tempSock = await startMobileRegistration(phoneNumber);
                
                if (tempSock) {
                    pendingMobileSockets[chatId] = { sock: tempSock, phone: phoneNumber };
                    userState[chatId] = 'WAITING_MOBILE_OTP';
                    bot.sendMessage(chatId, `**SMS Requested!**\n\nPlease check the phone and enter the 6-digit code here:`, { parse_mode: 'Markdown' });
                } else {
                    bot.sendMessage(chatId, `Failed to initialize mobile socket.`);
                }
            } catch (e) {
                bot.sendMessage(chatId, `Registration Error: ${e.message}`);
            }
            return;
        }

        // --- MOBILE API: STEP 2 (Receive SMS Code & Register) ---
        if (userState[chatId] === 'WAITING_MOBILE_OTP') {
            const otpCode = text.replace(/[^0-9]/g, '');
            if (otpCode.length !== 6) return bot.sendMessage(chatId, 'The code must be exactly 6 digits. Try again:');
            
            const pendingData = pendingMobileSockets[chatId];
            if (!pendingData || !pendingData.sock) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, 'Session expired or lost. Please run /login again.');
            }

            userState[chatId] = null;
            bot.sendMessage(chatId, `Verifying code ${otpCode}...`);

            try {
                // Submit the OTP to WhatsApp
                const res = await pendingData.sock.register(otpCode);
                
                bot.sendMessage(chatId, `**MOBILE LOGIN SUCCESSFUL!**\n\n+${pendingData.phone} is now a Primary Device!`, { parse_mode: 'Markdown' });
                
                // Cleanup
                delete pendingMobileSockets[chatId];
                
                // IMPORTANT: You now need to add this session to your active clients/database
                // just like you do in your standard startClient() function.
                
            } catch (e) {
                let errorMsg = e.message;
                if (errorMsg.includes('code_incorrect')) errorMsg = "The SMS code was incorrect.";
                bot.sendMessage(chatId, `Verification Failed: ${errorMsg}\n\nRun /login to try again.`);
                delete pendingMobileSockets[chatId];
            }
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


                  if (userState[chatId] === 'WAITING_SPLIT_COUNT') {
            const parts = parseInt(text.trim());
            
            // Safety checks
            if (isNaN(parts) || parts <= 1 || parts > 50) {
                userState[chatId] = null;
                userState[chatId + '_split_country'] = null;
                return bot.sendMessage(chatId, '[ERROR] Invalid amount. Please enter a number between 2 and 50. Process cancelled.');
            }

            const fileId = userState[chatId + '_split_file'];
            const rawCountryName = userState[chatId + '_split_country'] || "Data";
            const safeCountryName = rawCountryName.replace(/\s+/g, '_');
            
            userState[chatId] = null;
            userState[chatId + '_split_file'] = null;
            userState[chatId + '_split_country'] = null;

            if (!fileId) return bot.sendMessage(chatId, '[ERROR] File expired. Please reply to the file again.');

            // --- WIZARD: Ask about Country Codes ---
            const stripMode = await new Promise((resolve) => {
                let isResolved = false;
                bot.sendMessage(chatId, `[FORMAT SELECTION]\nDo you want to strip the country codes from the numbers before splitting?`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Yes, Strip Country Codes", callback_data: "split_strip_yes" }],
                            [{ text: "No, Keep Numbers As-Is", callback_data: "split_strip_no" }]
                        ]
                    }
                }).then(promptMsg => {
                    const listener = (query) => {
                        if (query.message.message_id === promptMsg.message_id && query.data.startsWith('split_strip_')) {
                            isResolved = true;
                            bot.removeListener('callback_query', listener);
                            bot.deleteMessage(chatId, promptMsg.message_id).catch(()=>{});
                            resolve(query.data === 'split_strip_yes');
                        }
                    };
                    bot.on('callback_query', listener);
                    // Default to NOT stripping if no selection is made in 60 seconds
                    setTimeout(() => { if (!isResolved) { bot.removeListener('callback_query', listener); resolve(false); } }, 60000);
                });
            });

            let statusMsg = await bot.sendMessage(chatId, `[PROCESSING] Downloading and dividing file into ${parts} parts...`);

            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await fetch(fileLink);
                const rawText = await response.text();

                // Extract all non-empty lines
                const rawLines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

                if (rawLines.length === 0) {
                    await bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
                    return bot.sendMessage(chatId, '[ERROR] The file appears to be empty.');
                }

                // Process numbers based on user selection
                let processedLines = [];
                for (const line of rawLines) {
                    let num = line.replace(/\D/g, ''); // Extract only digits
                    if (num.length === 0) continue;
                    
                    if (stripMode) {
                        try {
                            const res = normalizeWithCountry(num);
                            if (res && res.num) {
                                num = res.num; 
                            }
                        } catch (e) {
                            // If normalizer fails, fallback to the raw digits
                        }
                    }
                    processedLines.push(num);
                }

                if (processedLines.length < parts) {
                    await bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
                    return bot.sendMessage(chatId, `[ERROR] The file only has ${processedLines.length} valid numbers. Cannot split into ${parts} parts.`);
                }

                // Calculate chunk size
                const chunkSize = Math.ceil(processedLines.length / parts);
                
                await bot.editMessageText(
                    `[SPLITTING IN PROGRESS]\n\nTotal Numbers: ${processedLines.length}\nFiles: ${parts}\nLabel: ${safeCountryName}\nFormat: ${stripMode ? 'Country Codes Stripped' : 'Original Format'}\nSize per file: ~${chunkSize} numbers\n\nUploading...`,
                    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
                );

                // Slice, Format, and Send Files
                for (let i = 0; i < parts; i++) {
                    const chunk = processedLines.slice(i * chunkSize, (i + 1) * chunkSize);
                    if (chunk.length === 0) continue;

                    // --- FORMAT CHUNK: Batches of 5 with centered numbers ---
                    let formattedText = "";
                    let batchNumber = 1;
                    
                    for (let j = 0; j < chunk.length; j++) {
                        // If this is the very first number of a 5-block, add the batch header
                        if (j % 5 === 0) {
                            formattedText += `    ${batchNumber}    \n`;
                            batchNumber++;
                        }

                        formattedText += chunk[j];
                        
                        // If it's the 5th number in the block (and not the end of the file), add blank lines
                        if ((j + 1) % 5 === 0 && j !== chunk.length - 1) {
                            formattedText += "\n\n\n"; 
                        } else if (j !== chunk.length - 1) {
                            formattedText += "\n"; 
                        }
                    }

                    const buffer = Buffer.from(formattedText);
                    
                    await bot.sendDocument(
                        chatId, 
                        buffer, 
                        { caption: `[Part ${i + 1} of ${parts}]\nTotal: ${chunk.length} numbers`, parse_mode: 'Markdown' }, 
                        { filename: `Ultar_Sync_${safeCountryName}_${i + 1}.txt`, contentType: 'text/plain' } 
                    );
                    
                    await delay(1200); 
                }

                bot.sendMessage(chatId, `[SPLIT COMPLETE] Successfully generated ${parts} formatted files.`, { parse_mode: 'Markdown' });

            } catch (e) {
                bot.sendMessage(chatId, `[ERROR] ${e.message}`);
            }
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
            case "My Numbers": 
                deleteUserCommand(bot, msg);
                
                // --- SUBADMIN LOGIC: Show connected bot accounts ---
                if (isSubAdmin && !isUserAdmin) {
                    if (text === "My Account") {
                         return sendMenu(bot, chatId, '[ERROR] Access Denied. Use the "My Numbers" button.');
                    }
                    
                    const userSessions = await getAllSessions(userId);
                    let accMsg = `[MY CONNECTED ACCOUNTS]\n\n`;
                    
                    if (userSessions.length === 0) {
                        accMsg += `No accounts connected.\n`;
                    } else {
                        for (const session of userSessions) {
                            const id = session.short_id;
                            if (!id) continue; 
                            const status = clients[session.session_id] ? 'ONLINE' : 'OFFLINE';
                            const dur = getDuration(session.connected_at);
                            accMsg += `${id} | +${session.phone} | [${status}] | ${dur}\n`;
                        }
                    }
                    return sendMenu(bot, chatId, accMsg);
                }

                // --- ADMIN LOGIC: Fetch from Eden API ---
                if (isUserAdmin && text === "My Numbers") {
                    let statusMsg;
                    try {
                        statusMsg = await bot.sendMessage(chatId, "🔄 Fetching allocated numbers from API...");
                        
                        const CUSTOM_API_URL = "http://138.68.2.228/api/v1";
                        const API_KEY = process.env.CUSTOM_SMS_API_KEY || "85aea74148ad0c706cd02ef9da317e52184527a7df6d17ca403dbecf66e84773";
                        
                        // Added headers to force the server to return JSON, even on errors
                        const response = await fetch(`${CUSTOM_API_URL}/numbers?api_key=${API_KEY}`, {
                            headers: { 'Accept': 'application/json' }
                        });
                        
                        // Grab raw text first to check if it's an HTML error page
                        const rawText = await response.text();

                        if (rawText.trim().startsWith('<')) {
                             return bot.editMessageText(`❌ **[API SERVER ERROR]**\nThe Eden SMS server returned an HTML error page instead of data. Their \`/numbers\` endpoint might be down or broken right now.\n\n**HTTP Status:** ${response.status}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
                        }

                        // If it's safe, parse the JSON
                        const data = JSON.parse(rawText);

                        if (data.ok) {
                            if (!data.numbers || data.numbers.length === 0) {
                                return bot.editMessageText("⚠️ You currently have 0 allocated numbers on the panel.", { chat_id: chatId, message_id: statusMsg.message_id });
                            }

                            // Tally up the data for a nice summary
                            const serviceCount = {};
                            const countryCount = {};
                            
                            data.numbers.forEach(numObj => {
                                const svc = numObj.service || "Unknown";
                                const ctry = numObj.country || "Unknown";
                                
                                serviceCount[svc] = (serviceCount[svc] || 0) + 1;
                                countryCount[ctry] = (countryCount[ctry] || 0) + 1;
                            });

                            let summaryMsg = `📱 **YOUR EDEN NUMBERS**\n\n`;
                            summaryMsg += `**Total Allocated:** ${data.total}\n\n`;
                            
                            summaryMsg += `*By Service:*\n`;
                            for (const [svc, count] of Object.entries(serviceCount)) {
                                summaryMsg += `- ${svc}: ${count}\n`;
                            }

                            summaryMsg += `\n*By Country:*\n`;
                            for (const [ctry, count] of Object.entries(countryCount)) {
                                summaryMsg += `- ${ctry}: ${count}\n`;
                            }

                            // Store the raw array in memory so the download button can grab it
                            userState[chatId + '_api_numbers'] = data.numbers.map(n => n.phone);

                            // EDIT the original message
                            bot.editMessageText(summaryMsg, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: `📥 Download as .TXT (${data.total})`, callback_data: 'download_api_numbers' }],
                                        [{ text: 'Cancel', callback_data: 'cancel_action' }]
                                    ]
                                }
                            });

                        } else {
                            bot.editMessageText(`❌ [ERROR] API returned false: ${data.error || "Unknown error"}`, { chat_id: chatId, message_id: statusMsg.message_id });
                        }
                    } catch (e) {
                        if (statusMsg) {
                            bot.editMessageText(`❌ [ERROR] Failed to fetch numbers: ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
                        } else {
                            bot.sendMessage(chatId, `❌ [ERROR] ${e.message}`);
                        }
                    }
                }
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

                        case "Balance":
                deleteUserCommand(bot, msg);
                // Admin check is already handled by the general message block
                if (!isUserAdmin) return bot.sendMessage(chatId, "Admin only.");
                
                try {
                    bot.sendMessage(chatId, "Checking Eden SMS Balance...");
                    
                    const CUSTOM_API_URL = "http://138.68.2.228/api/v1";
                    const API_KEY = process.env.CUSTOM_SMS_API_KEY || "85aea74148ad0c706cd02ef9da317e52184527a7df6d17ca403dbecf66e84773";
                    
                    const response = await fetch(`${CUSTOM_API_URL}/balance?api_key=${API_KEY}`);
                    const data = await response.json();

                    if (data.ok) {
                        const balanceMsg = 
                            `**SMS BALANCE**\n\n` +
                            `**User:** \`${data.user_id}\`\n` +
                            `**Balance:** \`$${data.balance}\``;
                            
                        sendMenu(bot, chatId, balanceMsg);
                    } else {
                        bot.sendMessage(chatId, `[ERROR] API returned false: ${data.error || "Unknown error"}`);
                    }
                } catch (e) {
                    bot.sendMessage(chatId, `[ERROR] Failed to fetch balance: ${e.message}`);
                }
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


                // --- SECONDARY MENU FOR BOTH TXT AND TTX ---
        if (data === 'txt_menu_stream' || data === 'txt_menu_normal' || data === 'ttx_menu_stream' || data === 'ttx_menu_normal') {
            const cmdType = data.startsWith('txt') ? 'txt' : 'ttx';
            const modeName = data.includes('stream') ? 'stream' : 'normal';
            
            return bot.editMessageText(`[OUTPUT STYLE]\nHow do you want to receive the numbers?`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Send as .TXT Files', callback_data: `${cmdType}_run_${modeName}_file` }],
                        [{ text: 'Send in Chat Batches', callback_data: `${cmdType}_run_${modeName}_batch` }],
                        [{ text: 'Cancel', callback_data: 'cancel_action' }]
                    ]
                }
            });
        }



        
                  // --- /CONVT MENU 1: CHOOSE SORT METHOD ---
        if (data === 'convt_sort_cc' || data === 'convt_sort_rng') {
            await bot.answerCallbackQuery(query.id);
            const fileData = userState[chatId + '_convt_file'];
            if (!fileData) return bot.sendMessage(chatId, "[ERROR] File session expired. Please reply with /convt again.");

            if (data === 'convt_sort_rng' && !fileData.name.endsWith('.xlsx')) {
                return bot.sendMessage(chatId, "[ERROR] Grouping by Range requires an .xlsx file with a 'Range' column.");
            }

            userState[chatId + '_convt_sort'] = data === 'convt_sort_cc' ? 'cc' : 'rng';

            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Keep Country Code", callback_data: "convt_out_keep" }],
                        [{ text: "Strip Country Code", callback_data: "convt_out_strip" }]
                    ]
                }
            };
            return bot.editMessageText("Do you want to KEEP or STRIP the country code in the final text files?", { chat_id: chatId, message_id: query.message.message_id, reply_markup: opts.reply_markup });
        }

        
                
  

                // --- /CONVT MENU 2: EXECUTION ---
        if (data === 'convt_out_keep' || data === 'convt_out_strip') {
            await bot.answerCallbackQuery(query.id);
            const fileData = userState[chatId + '_convt_file'];
            const sortMode = userState[chatId + '_convt_sort'];
            const keepCode = data === 'convt_out_keep';

            if (!fileData || !sortMode) return bot.sendMessage(chatId, "[ERROR] Session expired. Please reply with /convt again.");

            userState[chatId + '_convt_file'] = null;
            userState[chatId + '_convt_sort'] = null;

            await bot.editMessageText(`[SYSTEM] Extracting & Sorting... (Strip Codes: ${keepCode ? 'NO' : 'YES'})`, { chat_id: chatId, message_id: query.message.message_id });

            try {
                const fileLink = await bot.getFileLink(fileData.id);
                const response = await fetch(fileLink);

                const groupedNumbers = {}; 
                const groupNames = {};     

                if (fileData.name.endsWith('.xlsx')) {
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const workbook = XLSX.read(buffer, { type: 'buffer' });
                    const sheet = workbook.Sheets[workbook.SheetNames[0]];

                    if (sortMode === 'rng') {
                        // 🚨 SMART HEADER HUNTER: Handles files where headers are pushed down
                        const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                        
                        let rangeColIndex = -1;
                        let numberColIndex = -1;
                        let dataStartIndex = 1;

                        // Scan the first 10 rows to find where the actual headers are
                        for (let i = 0; i < Math.min(10, rawData.length); i++) {
                            const row = rawData[i];
                            if (!Array.isArray(row)) continue;
                            
                            const lowerRow = row.map(cell => cell ? String(cell).toLowerCase().trim() : '');
                            
                            const rIdx = lowerRow.indexOf('range');
                            let nIdx = lowerRow.indexOf('number');
                            if (nIdx === -1) nIdx = lowerRow.indexOf('phone');

                            if (rIdx !== -1 && nIdx !== -1) {
                                rangeColIndex = rIdx;
                                numberColIndex = nIdx;
                                dataStartIndex = i + 1; // Data starts on the row immediately after headers
                                break;
                            }
                        }

                        if (rangeColIndex !== -1 && numberColIndex !== -1) {
                            for (let i = dataStartIndex; i < rawData.length; i++) {
                                const row = rawData[i];
                                if (!Array.isArray(row)) continue;

                                const num = row[numberColIndex];
                                const rangeName = row[rangeColIndex] || 'Unknown_Range';

                                if (num) {
                                    if (!groupedNumbers[rangeName]) {
                                        groupedNumbers[rangeName] = [];
                                        groupNames[rangeName] = `Range: ${rangeName}`;
                                    }
                                    groupedNumbers[rangeName].push(String(num));
                                }
                            }
                        } else {
                            throw new Error("Could not find both 'Range' and 'Number' columns in the Excel file.");
                        }
                    } else {
                        // GROUP BY COUNTRY CODE
                        const parsedData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                        parsedData.forEach(row => {
                            if (Array.isArray(row)) {
                                row.forEach(cell => {
                                    if (cell) {
                                        const numMatch = cell.toString().match(/\d{7,15}/g);
                                        if (numMatch) {
                                            numMatch.forEach(num => {
                                                const res = normalizeWithCountry(num);
                                                let groupKey = 'Unknown';
                                                let groupName = 'Unknown / Local';

                                                if (res && res.code && res.code !== 'N/A') {
                                                    groupKey = res.code;
                                                    groupName = `${res.name} (+${res.code})`;
                                                }

                                                if (!groupedNumbers[groupKey]) {
                                                    groupedNumbers[groupKey] = [];
                                                    groupNames[groupKey] = groupName;
                                                }
                                                groupedNumbers[groupKey].push(num);
                                            });
                                        }
                                    }
                                });
                            }
                        });
                    }
                } else if (fileData.name.endsWith('.txt')) {
                    // TXT files just group by Country Code
                    const rawText = await response.text();
                    const matches = rawText.match(/\d{7,15}/g) || [];

                    matches.forEach(num => {
                        const res = normalizeWithCountry(num);
                        let groupKey = 'Unknown';
                        let groupName = 'Unknown / Local';

                        if (res && res.code && res.code !== 'N/A') {
                            groupKey = res.code;
                            groupName = `${res.name} (+${res.code})`;
                        }

                        if (!groupedNumbers[groupKey]) {
                            groupedNumbers[groupKey] = [];
                            groupNames[groupKey] = groupName;
                        }
                        groupedNumbers[groupKey].push(num);
                    });
                }

                const keys = Object.keys(groupedNumbers);
                if (keys.length === 0) return bot.sendMessage(chatId, "[RESULT] No valid numbers found to extract. Check your columns.");

                bot.sendMessage(chatId, `[INFO] Found ${keys.length} group(s). Generating files...`);

                for (const groupKey of keys) {
                    const rawArray = groupedNumbers[groupKey];
                    const outputArray = [];

                    for (let num of rawArray) {
                        num = num ? String(num).trim() : "";
                        if (!num) continue;

                        const res = normalizeWithCountry(num);
                        if (res && res.num) {
                            if (keepCode) {
                                const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                                outputArray.push(fullPhone);
                            } else {
                                outputArray.push(res.num);
                            }
                        }
                    }

                    if (outputArray.length > 0) {
                        const uniqueArray = Array.from(new Set(outputArray));
                        const textBuffer = Buffer.from(uniqueArray.join('\n'));
                        
                        const safeName = groupKey.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_");
                        const suffix = keepCode ? "WithCode" : "Stripped";

                        let captionText = `**[CONVERT COMPLETE]**\n\n`;
                        captionText += `**Group:** ${groupNames[groupKey]}\n`;
                        captionText += `**Total Unique Numbers:** ${uniqueArray.length}\n`;
                        captionText += `**Mode:** ${keepCode ? 'Kept Country Code' : 'Stripped Country Code'}\n\n`;
                        captionText += `**OTP Grp:** [Tap to Join](https://chat.whatsapp.com/KGSHc7U07u3IqbUFPQX15q?mode=gi_t)`;

                        await bot.sendDocument(chatId, textBuffer, {
                            caption: captionText,
                            parse_mode: 'Markdown'
                        }, { filename: `converted_${safeName}_${suffix}.txt`, contentType: 'text/plain' });

                        await new Promise(resolve => setTimeout(resolve, 800)); 
                    }
                }

                bot.sendMessage(chatId, "[PROCESS COMPLETE] All files have been extracted and sent.");

            } catch (err) {
                console.error("Convt Error:", err);
                bot.sendMessage(chatId, "[ERROR] Failed to convert file: " + err.message);
            }
        }

                
               // --- SMART EXECUTION & RESUME ENGINE FOR TXT AND TTX ---
        if (data.startsWith('txt_run_') || data.startsWith('ttx_run_') || data === 'resume_stream_txt') {
            await bot.answerCallbackQuery(query.id);
            
            let job;
            
            // 1. LOAD OR CREATE JOB
            if (data === 'resume_stream_txt') {
                job = userState[chatId + '_stream_txt'];
                if (!job) return bot.sendMessage(chatId, "[ERROR] No paused job found. It may have expired or finished.");
                try { await bot.deleteMessage(chatId, query.message.message_id); } catch(e){}
            } else {
                try { await bot.deleteMessage(chatId, query.message.message_id); } catch(e){}
                
                const cmdType = data.startsWith('txt') ? 'txt' : 'ttx';
                const fileId = userState[chatId + `_${cmdType}_file`];
                
                if (!fileId) return bot.sendMessage(chatId, `[ERROR] File expired or lost. Please reply to the file with /${cmdType} again.`);
                userState[chatId + `_${cmdType}_file`] = null;

                const isStreaming = data.includes('stream');
                const outputAsFile = data.includes('file');

                bot.sendMessage(chatId, `[SYSTEM] Downloading file and building memory...`);

                // Build DB & Session Exclusion List
                const connectedSet = new Set();
                Object.values(shortIdMap).forEach(session => {
                    const res = normalizeWithCountry(session.phone);
                    if (res) {
                        const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                        connectedSet.add(fullPhone);
                    }
                });
                
                const allDbDocs = await getAllNumbers(); 
                const dbSet = new Set();
                allDbDocs.forEach(doc => {
                    const rawStr = String(doc.number || doc).replace(/\D/g, '');
                    const res = normalizeWithCountry(rawStr);
                    if (res && res.num) {
                        const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                        dbSet.add(fullPhone);
                    } else {
                        dbSet.add(rawStr);
                    }
                });

                const fileLink = await bot.getFileLink(fileId);
                const response = await fetch(fileLink);
                const rawText = await response.text();
                const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

                job = {
                    cmdType, isStreaming, outputAsFile, lines,
                    currentIndex: 0, totalChecked: 0, validCount: 0, skippedCount: 0,
                    bannedNumbers: [], activeBatch: [], activeFileArray: [],
                    failedFolders: [], // Tracks dead bots so it doesn't loop
                    detectedCountry: "Unknown", detectedCode: "N/A",
                    connectedSet: Array.from(connectedSet),
                    dbSet: Array.from(dbSet),
                    statusMsgId: null
                };
                
                userState[chatId + '_stream_txt'] = job;
            }

            // 2. THE ENGINE SETUP
            const isUserAdmin = (userId === ADMIN_ID);
            let statusMsg = await bot.sendMessage(chatId, `[SYSTEM] Starting Processing Engine...`);
            job.statusMsgId = statusMsg.message_id;

            let currentFolder = null;
            let sock = null;
            let checkerNum = "None";

                        const getActiveSocket = async () => {
                let availableFolders = [];
                if (isUserAdmin) {
                    availableFolders = Object.keys(clients).filter(f => clients[f] && f !== currentOtpSenderId && !job.failedFolders.includes(f));
                } else {
                    const mySessions = await getAllSessions(userId);
                    const mySessionIds = mySessions.map(s => s.session_id);
                    availableFolders = mySessionIds.filter(f => clients[f] && f !== currentOtpSenderId && !job.failedFolders.includes(f));
                }
                
                // SAFER CHECK: Just verify the socket exists and has a logged-in user identity
                for (const folder of availableFolders) {
                    const tempSock = clients[folder];
                    if (tempSock && tempSock.user && tempSock.user.id) {
                        currentFolder = folder;
                        sock = tempSock;
                        checkerNum = sock.user.id.split(':')[0];
                        return true;
                    } else {
                        job.failedFolders.push(folder);
                    }
                }
                return false;
            };


            if (job.isStreaming) {
                const hasBot = await getActiveSocket();
                if (!hasBot) {
                    return bot.sendMessage(chatId, `[ERROR] NO BOTS AVAILABLE!\nPlease connect a WhatsApp account to continue processing.`, {
                        reply_markup: { inline_keyboard: [[{text: "Resume Processing", callback_data: "resume_stream_txt"}]] }
                    });
                }
                bot.sendMessage(chatId, `[STREAMING MODE]\nUsing Bot: +${checkerNum}`);
            }

            userState[chatId + '_stopFlag'] = false; 
            const fastConnectedSet = new Set(job.connectedSet);
            const fastDbSet = new Set(job.dbSet);

            // 3. PROCESSING LOOP
            for (let i = job.currentIndex; i < job.lines.length; i++) {
                if (userState[chatId + '_stopFlag']) {
                    job.currentIndex = i; 
                    break;
                }

                job.currentIndex = i;
                const line = job.lines[i];
                const res = normalizeWithCountry(line);
                
                if (!res || !res.num) continue; 

                if (job.detectedCountry === "Unknown" && res.name !== "Local/Unknown") {
                    job.detectedCountry = res.name;
                    job.detectedCode = res.code;
                }

                const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                const numberToOutput = job.cmdType === 'txt' ? res.num : fullPhone;

                if (fastConnectedSet.has(fullPhone) || fastDbSet.has(fullPhone)) {
                    job.skippedCount++;
                    continue;
                }

                job.totalChecked++;

                if (job.isStreaming) {
                    // FAILOVER SYSTEM: Check if current bot died or was banned mid-way
                                        // FAILOVER SYSTEM: Check if current bot died or was banned mid-way
                    if (!clients[currentFolder] || !sock || !sock.user) {
                        bot.sendMessage(chatId, `[WARNING] Bot +${checkerNum} disconnected or was BANNED!\n[SYSTEM] Finding a new bot...`);
                        
                        if (currentFolder) job.failedFolders.push(currentFolder);
                        
                        const hasNewBot = await getActiveSocket();
                        if (!hasNewBot) {
                            job.currentIndex = i; 
                            return bot.sendMessage(chatId, `[FATAL ERROR] ALL BOTS ARE DEAD OR BANNED!\nStopped at ${i}/${job.lines.length}.\nConnect a new WhatsApp account and tap resume.`, {
                                reply_markup: { inline_keyboard: [[{text: "Resume Processing", callback_data: "resume_stream_txt"}]] }
                            });
                        }
                        bot.sendMessage(chatId, `[SUCCESS] Successfully switched to Bot: +${checkerNum}`);
                        i--; 
                        continue;
                    }


                    try {
                        const jid = `${fullPhone}@s.whatsapp.net`;
                        const checkPromise = sock.onWhatsApp(jid);
                        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("WA_TIMEOUT")), 5000));
                        
                        const [check] = await Promise.race([checkPromise, timeoutPromise]);
                        
                        if (check && check.exists) {
                            job.validCount++;
                            if (job.outputAsFile) {
                                job.activeFileArray.push(numberToOutput);
                            } else {
                                job.activeBatch.push(numberToOutput);
                                if (job.activeBatch.length === 5) {
                                    await bot.sendMessage(chatId, job.activeBatch.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                                    job.activeBatch = []; 
                                    await delay(1000); 
                                }
                            }
                        } else {
                            job.bannedNumbers.push(numberToOutput);
                        }
                         } catch (err) {
                        // If the bot died exactly during this request, step back and trigger failover
                        if (err.message !== "WA_TIMEOUT" && (!clients[currentFolder] || !sock || !sock.user)) {
                            i--; 
                            continue;
                        }
                        job.bannedNumbers.push(numberToOutput); 
                    }


                    await delay(500); // Anti-ban delay

                } else {
                    job.validCount++;
                    if (job.outputAsFile) {
                        job.activeFileArray.push(numberToOutput); 
                    } else {
                        job.activeBatch.push(numberToOutput); 
                        if (job.activeBatch.length === 5) {
                            await bot.sendMessage(chatId, job.activeBatch.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                            job.activeBatch = [];
                            await delay(800);
                        }
                    }
                }

                // 4. LIVE PROGRESS DASHBOARD
                if (i > 0 && i % 10 === 0) {
                    const percent = Math.floor((i / job.lines.length) * 100);
                    const left = job.lines.length - i;
                    const progressMsg = 
                        `[STREAMING IN PROGRESS]\n\n` +
                        `Progress: ${percent}% [${i}/${job.lines.length}]\n` +
                        `Remaining: ${left}\n` +
                        `Active: ${job.validCount}\n` +
                        (job.isStreaming ? `Weak/Dead: ${job.bannedNumbers.length}\n` : '') +
                        `Skipped (DB/Dupe): ${job.skippedCount}\n\n` +
                        (job.isStreaming ? `Current Bot: +${checkerNum}` : `Mode: Normal Filter`);
                    
                    try {
                        await bot.editMessageText(progressMsg, {chat_id: chatId, message_id: job.statusMsgId, parse_mode: 'Markdown'});
                    } catch(e){} // Ignore 'message is not modified' errors
                }
            }

            // 5. END OF PROCESSING / SUMMARY
            const isAborted = userState[chatId + '_stopFlag'];
            userState[chatId + '_stopFlag'] = false;

            if (isAborted) {
                return bot.sendMessage(chatId, `[PAUSED] Process Manually Paused.\nStopped at ${job.currentIndex} / ${job.lines.length}.`, {
                    reply_markup: { inline_keyboard: [[{text: "Resume Processing", callback_data: "resume_stream_txt"}]] }
                });
            }

            userState[chatId + '_stream_txt'] = null;

            if (!job.outputAsFile && job.activeBatch.length > 0) {
                await bot.sendMessage(chatId, job.activeBatch.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
            }

            if (!job.outputAsFile && job.isStreaming && job.bannedNumbers.length > 0) {
                await bot.sendMessage(chatId, `[BANNED / DEAD] (${job.bannedNumbers.length})`, { parse_mode: 'Markdown' });
                for (let i = 0; i < job.bannedNumbers.length; i += 10) {
                    const chunk = job.bannedNumbers.slice(i, i + 10);
                    if (chunk.length > 0) {
                        await bot.sendMessage(chatId, chunk.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                        await delay(800);
                    }
                }
            }

            let finalSummary = `[PROCESS COMPLETE]\n\n`;
            finalSummary += `Country Detected: ${job.detectedCountry} (+${job.detectedCode})\n`;
            finalSummary += `Total Checked: ${job.totalChecked}\n`;
            finalSummary += `Active: ${job.validCount}\n`;
            if (job.isStreaming) finalSummary += `Weak/Dead: ${job.bannedNumbers.length}\n`;
            finalSummary += `Skipped (DB/Dupe): ${job.skippedCount}\n\n`;
            finalSummary += `*Always save temporarily banned numbers so you can reuse them later.*\n`;
            finalSummary += `[Tap to Join OTP Grp](https://t.me/+MLS1oZxY6TtiMTQ1)`;

               if (job.outputAsFile) {
                // --- FORMAT ACTIVE NUMBERS LIKE /SPLIT ---
                let formattedActiveText = "";
                let batchNum = 1;
                for (let j = 0; j < job.activeFileArray.length; j++) {
                    // Add batch header for every 5th number
                    if (j % 5 === 0) {
                        formattedActiveText += `    ${batchNum}    \n`;
                        batchNum++;
                    }
                    formattedActiveText += job.activeFileArray[j];
                    
                    // Add spacing between batches
                    if ((j + 1) % 5 === 0 && j !== job.activeFileArray.length - 1) {
                        formattedActiveText += "\n\n\n"; 
                    } else if (j !== job.activeFileArray.length - 1) {
                        formattedActiveText += "\n"; 
                    }
                }
                // ----------------------------------------

                if (job.activeFileArray.length > 0 && job.isStreaming && job.bannedNumbers.length > 0) {
                    const tempActive = `./Active_WA_Numbers_${Date.now()}.txt`;
                    const tempWeak = `./Weak_WA_Numbers_${Date.now()}.txt`;
                    
                    // Use the formatted text instead of just joining with newlines
                    fs.writeFileSync(tempActive, formattedActiveText);
                    fs.writeFileSync(tempWeak, job.bannedNumbers.join('\n'));

                    try {
                        await bot.sendMediaGroup(chatId, [
                            { type: 'document', media: tempActive, caption: finalSummary, parse_mode: 'Markdown' },
                            { type: 'document', media: tempWeak }
                        ]);
                    } catch (err) {
                        await bot.sendDocument(chatId, tempActive, { caption: finalSummary, parse_mode: 'Markdown' });
                        await bot.sendDocument(chatId, tempWeak);
                    }
                    if (fs.existsSync(tempActive)) fs.unlinkSync(tempActive);
                    if (fs.existsSync(tempWeak)) fs.unlinkSync(tempWeak);

                } else if (job.activeFileArray.length > 0) {
                    // Use the formatted text here as well
                    const activeBuffer = Buffer.from(formattedActiveText);
                    await bot.sendDocument(chatId, activeBuffer, { caption: finalSummary, parse_mode: 'Markdown' }, { filename: 'Active_WA_Numbers.txt', contentType: 'text/plain' });
                } else if (job.isStreaming && job.bannedNumbers.length > 0) {
                    const deadBuffer = Buffer.from(job.bannedNumbers.join('\n'));
                    await bot.sendDocument(chatId, deadBuffer, { caption: finalSummary, parse_mode: 'Markdown' }, { filename: 'Weak_WA_Numbers.txt', contentType: 'text/plain' });
                } else {
                    await bot.sendMessage(chatId, finalSummary, { parse_mode: 'Markdown', disable_web_page_preview: true });
                }
            } else {
                await bot.sendMessage(chatId, finalSummary, { parse_mode: 'Markdown', disable_web_page_preview: true });
            }
            return;
        }

 


                // --- DOWNLOAD API NUMBERS ---
        if (data === 'download_api_numbers') {
            await bot.answerCallbackQuery(query.id, 'Preparing file...');
            
            const numbersArray = userState[chatId + '_api_numbers'];
            
            if (!numbersArray || numbersArray.length === 0) {
                return bot.sendMessage(chatId, '[ERROR] Data expired. Please click "My Numbers" again to fetch fresh data.');
            }

            // Create the text buffer
            const buffer = Buffer.from(numbersArray.join('\n'));

            // Send the file
            await bot.sendDocument(
                chatId, 
                buffer, 
                { 
                    caption: `**API NUMBERS EXPORTED**\nTotal: ${numbersArray.length}\nFormat: Clean Numbers`,
                    parse_mode: 'Markdown'
                }, 
                { 
                    filename: `Eden_Numbers_${Date.now()}.txt`, 
                    contentType: 'text/plain' 
                }
            );

            // Clean up the memory and remove the inline buttons from the summary message
            userState[chatId + '_api_numbers'] = null;
            return bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
        }


                // --- FILE MERGER BUTTONS ---
        if (data === 'drop_merged_file') {
            await bot.answerCallbackQuery(query.id);
            if (!mergeBuffer[chatId] || mergeBuffer[chatId].size === 0) {
                return bot.sendMessage(chatId, '[ERROR] Your merge buffer is empty.');
            }

            const allNumbers = Array.from(mergeBuffer[chatId]);
            const buffer = Buffer.from(allNumbers.join('\n'));

            await bot.sendDocument(
                chatId, 
                buffer, 
                { 
                    caption: `**MERGED FILE COMPLETE**\n\nTotal Numbers: ${allNumbers.length}\nBuffer has been cleared.`,
                    parse_mode: 'Markdown'
                }, 
                { filename: `Merged_Numbers_${Date.now()}.txt`, contentType: 'text/plain' }
            );

            // Empty the pool after dropping the file
            mergeBuffer[chatId] = new Set();
            return;
        }

        if (data === 'clear_merge_buffer') {
            await bot.answerCallbackQuery(query.id, 'Buffer cleared.');
            mergeBuffer[chatId] = new Set();
            return bot.editMessageText(`Merge buffer has been cleared.`, { chat_id: chatId, message_id: query.message.message_id });
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



                // --- GETNUM EXECUTION (LolzFack_bot via Dedicated Acc) ---
        if (data === 'getnum_out_batch' || data === 'getnum_out_txt') {
            await bot.answerCallbackQuery(query.id);
            const countLimit = userState[chatId + '_getnum_limit'];

            if (!countLimit) return bot.sendMessage(chatId, "[ERROR] Session expired. Please use /getnum again.");
            userState[chatId + '_getnum_limit'] = null; // clear memory

            const isBatch = data === 'getnum_out_batch';
            const targetBot = "LolzFack_bot";
            let totalFetched = 0;
            let fetchedNumbers = [];
            let currentBatch = [];
            let noNewNumsCount = 0; 

            await bot.editMessageText(`**Scraping ${countLimit} numbers...**\nPlease wait...`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });

            try {
                // ✅ Use the dedicated connection
                await ensureGetnumConnected(); 

                while (totalFetched < countLimit) {
                    const res = await getnumUserBot.getMessages(targetBot, { limit: 1 }); 
                    const currentMsg = res[0];
                    const text = currentMsg?.message || "";

                    if (text.includes("New Numbers:")) {
                        let newNumsFound = false;

                        // 1. Extract Numbers from Buttons
                        if (currentMsg.replyMarkup && currentMsg.replyMarkup.rows) {
                            for (const row of currentMsg.replyMarkup.rows) {
                                for (const b of row.buttons) {
                                    const btnText = b.text || "";
                                    
                                    // Skip the red/dark action buttons
                                    if (!btnText.toLowerCase().includes('change') && !btnText.toLowerCase().includes('help')) {
                                        const match = btnText.match(/\d{9,15}/);
                                        if (match) {
                                            const num = match[0];
                                            if (!fetchedNumbers.includes(num)) {
                                                fetchedNumbers.push(num);
                                                currentBatch.push(`\`${num}\``);
                                                totalFetched++;
                                                newNumsFound = true;
                                                if (totalFetched >= countLimit) break;
                                            }
                                        }
                                    }
                                }
                                if (totalFetched >= countLimit) break;
                            }
                        }

                        // 2. Failsafe (if bot runs out of stock or gives identical numbers)
                        if (!newNumsFound) {
                            noNewNumsCount++;
                            if (noNewNumsCount > 5) {
                                await bot.sendMessage(chatId, "**Stopped Early:** @LolzFack_bot stopped giving new numbers (might be out of stock).", { parse_mode: 'Markdown' });
                                break;
                            }
                        } else {
                            noNewNumsCount = 0; 
                        }

                        // 3. Output in Batches (if selected)
                        if (isBatch && currentBatch.length >= 6) {
                            await bot.sendMessage(chatId, `[BATCH]\n\n${currentBatch.join('\n')}`, { parse_mode: 'Markdown' });
                            currentBatch = [];
                        }

                        if (totalFetched >= countLimit) break;

                        // 4. Click the "Change Number" Button
                        let clicked = false;
                        if (currentMsg.replyMarkup && currentMsg.replyMarkup.rows) {
                            for (let r = 0; r < currentMsg.replyMarkup.rows.length; r++) {
                                const row = currentMsg.replyMarkup.rows[r];
                                for (let c = 0; c < row.buttons.length; c++) {
                                    const btnText = row.buttons[c].text || "";
                                    if (btnText.toLowerCase().includes("change number")) {
                                        await currentMsg.click(r, c); // GramJS coordinate clicking
                                        clicked = true;
                                        break;
                                    }
                                }
                                if (clicked) break;
                            }
                        }

                        if (clicked) {
                            await delay(4000); 
                        } else {
                            // Fallback if button goes missing
                            await getnumUserBot.sendMessage(targetBot, { message: "📞 Get Number" }); 
                            await delay(4000);
                        }

                    } else {
                        // Message wasn't the target yet, wait and retry
                        await delay(2000);
                    }
                }

                // --- FINAL DELIVERY ---
                if (isBatch && currentBatch.length > 0) {
                    await bot.sendMessage(chatId, `[BATCH - FINAL]\n\n${currentBatch.join('\n')}`, { parse_mode: 'Markdown' });
                }

                if (!isBatch && fetchedNumbers.length > 0) {
                    const buffer = Buffer.from(fetchedNumbers.join('\n'));
                    await bot.sendDocument(chatId, buffer, {
                        caption: `**Successfully extracted ${fetchedNumbers.length} numbers!**`,
                        parse_mode: 'Markdown'
                    }, { filename: `LolzFack_Numbers_${Date.now()}.txt`, contentType: 'text/plain' });
                } else if (isBatch && fetchedNumbers.length > 0) {
                    bot.sendMessage(chatId, `**Successfully extracted all ${totalFetched} numbers.**`, { parse_mode: 'Markdown' });
                }

            } catch (err) {
                bot.sendMessage(chatId, "[ERROR] " + err.message);
            }
        }


        
                // --- XL COMMAND: STEP 1 (COUNTRY SELECTION) ---
        if (data.startsWith('xl_c_')) {
            const countryCode = data.replace('xl_c_', '');
            userState[chatId + '_xl_country'] = countryCode;

            await bot.answerCallbackQuery(query.id);
            await bot.editMessageText(
                `[COUNTRY SELECTED: +${countryCode}]\n\nSelect checking mode:`,
                {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Streaming Mode (Check WA)', callback_data: 'xl_m_stream' }],
                            [{ text: 'Normal Mode (Filter Only)', callback_data: 'xl_m_normal' }],
                            [{ text: 'Cancel', callback_data: 'cancel_action' }]
                        ]
                    }
                }
            );
            return;
        }

        // --- XL COMMAND: STEP 2 (MODE SELECTION) ---
        if (data.startsWith('xl_m_')) {
            const selectedMode = data.replace('xl_m_', ''); 
            userState[chatId + '_xl_mode'] = selectedMode;

            return bot.editMessageText(`[OUTPUT STYLE]\nHow do you want to receive the numbers?`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Send as .TXT Files', callback_data: 'xl_run_file' }],
                        [{ text: 'Send in Chat Batches', callback_data: 'xl_run_batch' }],
                        [{ text: 'Cancel', callback_data: 'cancel_action' }]
                    ]
                }
            });
        }

        // --- XL COMMAND: STEP 3 (EXECUTION) ---
        if (data.startsWith('xl_run_')) {
            await bot.answerCallbackQuery(query.id);
            await bot.deleteMessage(chatId, query.message.message_id);

            const fileId = userState[chatId + '_xl_file'];
            const targetCountryCode = userState[chatId + '_xl_country'];
            const selectedMode = userState[chatId + '_xl_mode'];
            
            if (!fileId || !targetCountryCode || !selectedMode) {
                return bot.sendMessage(chatId, '[ERROR] Session expired. Please reply to the file with /xl again.');
            }

            userState[chatId + '_xl_file'] = null;
            userState[chatId + '_xl_country'] = null;
            userState[chatId + '_xl_mode'] = null;

            const isStreaming = selectedMode === 'stream';
            const outputAsFile = data.includes('file');

            try {
                let sock = null;
                if (isStreaming) {
                    const activeFolders = Object.keys(clients).filter(f => clients[f] && f !== currentOtpSenderId);
                    sock = activeFolders.length > 0 ? clients[activeFolders[0]] : null;
                    
                    if (sock) {
                        const checkerNum = sock.user.id.split(':')[0]; 
                        bot.sendMessage(chatId, `[STREAMING MODE: +${targetCountryCode}]\nUsing: ${checkerNum}\nChecking WA status...`);
                    } else {
                        return bot.sendMessage(chatId, '[ERROR] No checker account available for Streaming Mode.');
                    }
                } else {
                    bot.sendMessage(chatId, `[NORMAL MODE: +${targetCountryCode}]\nFiltering numbers without WA check...`);
                }

                // HYPER-AGGRESSIVE EXCLUSION LIST: Stores Raw, Local, and International variants
                const connectedSet = new Set();
                Object.values(shortIdMap).forEach(session => {
                    const res = normalizeWithCountry(session.phone);
                    if (res) {
                        connectedSet.add(res.num);
                        const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                        connectedSet.add(fullPhone);
                    }
                });
                
                const allDbDocs = await getAllNumbers(); 
                const dbSet = new Set();
                allDbDocs.forEach(doc => {
                    const rawStr = String(doc.number || doc).replace(/\D/g, '');
                    dbSet.add(rawStr); 
                    const res = normalizeWithCountry(rawStr);
                    if (res && res.num) {
                        dbSet.add(res.num); 
                        const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
                        dbSet.add(fullPhone); 
                    }
                });

                const fileLink = await bot.getFileLink(fileId);
                const response = await fetch(fileLink);
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const excelData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                let activeBatch = []; 
                let activeFileArray = [];
                const bannedNumbers = []; 
                let totalProcessed = 0;
                let validCount = 0;
                let skippedCount = 0;

                userState[chatId + '_stopFlag'] = false;

                for (const row of excelData) {
                    if (userState[chatId + '_stopFlag']) break;
                    if (!Array.isArray(row)) continue;
                    
                    for (const cell of row) {
                        if (userState[chatId + '_stopFlag']) break;
                        if (!cell) continue;
                        
                        const cellStr = cell.toString();
                        const matches = cellStr.match(/\d{7,15}/g) || [];
                        
                        for (const rawNum of matches) {
                            if (userState[chatId + '_stopFlag']) break;

                            const res = normalizeWithCountry(rawNum);
                            
                            if (!res || !res.num) continue;
                            if (res.code !== targetCountryCode) continue;

                            const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;

                            // STRICT FILTER: Checks all 3 possible variations of the number
                            if (connectedSet.has(fullPhone) || connectedSet.has(res.num) || dbSet.has(fullPhone) || dbSet.has(res.num) || dbSet.has(rawNum)) {
                                skippedCount++;
                                continue;
                            }

                            if (isStreaming && sock) {
                                totalProcessed++;
                                try {
                                    const jid = `${fullPhone}@s.whatsapp.net`;
                                    const checkPromise = sock.onWhatsApp(jid);
                                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("WA_TIMEOUT")), 5000));
                                    
                                    const [check] = await Promise.race([checkPromise, timeoutPromise]);
                                    
                                    if (check && check.exists) {
                                        validCount++;
                                        if (outputAsFile) {
                                            activeFileArray.push(res.num);
                                        } else {
                                            activeBatch.push(res.num);
                                            if (activeBatch.length === 5) {
                                                await bot.sendMessage(chatId, activeBatch.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                                                activeBatch = []; 
                                                await delay(1000); 
                                            }
                                        }
                                    } else {
                                        bannedNumbers.push(res.num);
                                    }
                                } catch (err) {
                                    bannedNumbers.push(res.num);
                                }

                                if (totalProcessed % 5 === 0) await delay(500); 

                            } else {
                                totalProcessed++;
                                validCount++;
                                if (outputAsFile) {
                                    activeFileArray.push(res.num);
                                } else {
                                    activeBatch.push(res.num);
                                    if (activeBatch.length === 5) {
                                        await bot.sendMessage(chatId, activeBatch.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                                        activeBatch = [];
                                        await delay(800);
                                    }
                                }
                            }
                        }
                    }
                }

                const isAborted = userState[chatId + '_stopFlag'];
                userState[chatId + '_stopFlag'] = false;

                if (!outputAsFile && activeBatch.length > 0) {
                    await bot.sendMessage(chatId, activeBatch.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                }

                if (!outputAsFile && isStreaming && sock && bannedNumbers.length > 0) {
                    await bot.sendMessage(chatId, `[BANNED / DEAD] (${bannedNumbers.length})`, { parse_mode: 'Markdown' });
                    for (let i = 0; i < bannedNumbers.length; i += 10) {
                        const chunk = bannedNumbers.slice(i, i + 10);
                        if (chunk.length > 0) {
                            await bot.sendMessage(chatId, chunk.map(n => `\`${n}\``).join('\n'), { parse_mode: 'Markdown' });
                            await delay(800);
                        }
                    }
                }

                let finalSummary = isAborted ? `[PROCESS ABORTED BY USER]\n\n` : `[PROCESS COMPLETE]\n\n`;
                finalSummary += `Command Used: /XL\n`;
                finalSummary += `Target: +${targetCountryCode}\n`;
                finalSummary += `Total Checked: ${totalProcessed}\n`;
                finalSummary += `Active: ${validCount}\n`;
                if (isStreaming) finalSummary += `Weak: ${bannedNumbers.length}\n`;
                finalSummary += `Skipped (Duplicates/DB): ${skippedCount}`;
                finalSummary += `\n\nAlways save temporarily banned numbers so you can reuse them later.`;
                finalSummary += `\nOTP Grp: [Join](https://t.me/+MLS1oZxY6TtiMTQ1)`;

                if (outputAsFile) {
                    if (activeFileArray.length > 0 && isStreaming && bannedNumbers.length > 0) {
                        
                        const tempDir = `./tmp_xl_${Date.now()}_${chatId}`;
                        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
                        
                        const tempActive = `${tempDir}/Active_WA_Numbers.txt`;
                        const tempWeak = `${tempDir}/Weak_WA_Numbers.txt`;

                        fs.writeFileSync(tempActive, activeFileArray.join('\n'));
                        fs.writeFileSync(tempWeak, bannedNumbers.join('\n'));

                        try {
                            await bot.sendMediaGroup(chatId, [
                                {
                                    type: 'document',
                                    media: tempActive,
                                    caption: finalSummary,
                                    parse_mode: 'Markdown'
                                },
                                {
                                    type: 'document',
                                    media: tempWeak
                                }
                            ]);
                        } catch (err) {
                            await bot.sendDocument(chatId, tempActive, { caption: finalSummary, parse_mode: 'Markdown' });
                            await bot.sendDocument(chatId, tempWeak);
                        }

                        if (fs.existsSync(tempActive)) fs.unlinkSync(tempActive);
                        if (fs.existsSync(tempWeak)) fs.unlinkSync(tempWeak);
                        if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);

                    } else if (activeFileArray.length > 0) {
                        const activeBuffer = Buffer.from(activeFileArray.join('\n'));
                        await bot.sendDocument(
                            chatId, 
                            activeBuffer, 
                            { caption: finalSummary, parse_mode: 'Markdown' }, 
                            { filename: 'Active_WA_Numbers.txt', contentType: 'text/plain' }
                        );
                    } else if (isStreaming && bannedNumbers.length > 0) {
                        const deadBuffer = Buffer.from(bannedNumbers.join('\n'));
                        await bot.sendDocument(
                            chatId, 
                            deadBuffer, 
                            { caption: finalSummary, parse_mode: 'Markdown' }, 
                            { filename: 'Weak_WA_Numbers.txt', contentType: 'text/plain' }
                        );
                    } else {
                        await bot.sendMessage(chatId, finalSummary, { parse_mode: 'Markdown' });
                    }
                } else {
                    await bot.sendMessage(chatId, finalSummary, { parse_mode: 'Markdown' });
                }

            } catch (e) {
                bot.sendMessage(chatId, `[ERROR] ${e.message}`);
            }
            return;
        }
        
                                    


        // Handle withdrawal approval
        if (data.startsWith('approve_')) {
            const withdrawId = parseInt(data.split('_')[1]);
            await updateWithdrawalStatus(withdrawId, 'APPROVED');
            await bot.editMessageText(`[APPROVED] Withdrawal #${withdrawId} approved.`, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id, { text: 'Withdrawal approved' });
            return;
        }

                // --- REGENERATE PAIRING CODE ---
        if (data.startsWith('regen_pair_')) {
            await bot.answerCallbackQuery(query.id, 'Generating new code...');
            const number = data.split('regen_pair_')[1]; // Extract the phone number from the button
            
            // 1. Edit the old message so the user knows it's working
            try {
                await bot.editMessageText(`**Regenerating new pairing code for +${number}...**`, { 
                    chat_id: chatId, 
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
            } catch (e) {}

            // 2. Generate a fresh session ID and restart the client
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            
            // 3. Auto-enable AntiMsg for the new session
            try {
                await setAntiMsgStatus(sessionId, true);
            } catch (e) {}
            
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
