import fs from 'fs';
import nodemailer from 'nodemailer';
import { delay } from '@whiskeysockets/baileys';
import { 
    addNumbersToDb, getAllNumbers, clearAllNumbers, 
    setAntiMsgStatus, setAutoSaveStatus, countNumbers, deleteNumbers, addToBlacklist,
    getAllSessions, getUser, createUser, getReferrals, updateBank, createWithdrawal,
    getEarningsStats, getHistory, banUser
} from './db.js';

const ADMIN_ID = process.env.ADMIN_ID;
const userState = {}; 
const POINTS_PER_HOUR = 10;
const EXCHANGE_RATE = 0.6; 
const MIN_WITHDRAW = 1000;

// EMAIL CONFIG
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendReportEmail(targetNumber) {
    if (!process.env.EMAIL_USER) return "Email not configured";
    // ... (Email logic same as before)
    return "Email Sent";
}

// --- KEYBOARDS (PERSISTENT) ---
// Removed "one_time_keyboard: true" to keep them visible
const userKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Connect Account" }, { text: "My Account" }],
            [{ text: "Dashboard" }, { text: "Referrals" }],
            [{ text: "Withdraw" }, { text: "Support" }]
        ],
        resize_keyboard: true,
        is_persistent: true // Keeps keyboard always visible
    }
};

const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Connect Account" }, { text: "List All" }],
            [{ text: "Clear Database" }]
        ],
        resize_keyboard: true,
        is_persistent: true
    }
};

function getKeyboard(chatId) {
    return (chatId.toString() === ADMIN_ID) ? adminKeyboard : userKeyboard;
}

// --- DURATION HELPER ---
function getDuration(startDate) {
    if (!startDate) return "Just now";
    const diff = Date.now() - new Date(startDate).getTime();
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    let duration = "";
    if (days > 0) duration += `${days}d `;
    if (hours > 0) duration += `${hours}h `;
    duration += `${minutes}m`;
    return duration.trim();
}

// --- UTILS ---
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

// --- BROADCAST LOGIC ---
async function executeBroadcast(bot, clients, shortIdMap, chatId, targetId, messageText) {
    const sessionData = shortIdMap[targetId];
    if (!sessionData || !clients[sessionData.folder]) {
        return bot.sendMessage(chatId, 'Client disconnected.', getKeyboard(chatId));
    }
    const sock = clients[sessionData.folder];
    const numbers = await getAllNumbers();
    if (numbers.length === 0) return bot.sendMessage(chatId, 'Empty list.', getKeyboard(chatId));

    bot.sendMessage(chatId, `Flashing ${numbers.length} numbers...`);
    let successCount = 0;
    const successfulNumbers = [];
    const BATCH_SIZE = 50; 
    
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        const batchTasks = batch.map(async (num) => {
            try {
                await sock.sendMessage(`${num}@s.whatsapp.net`, { text: messageText });
                successfulNumbers.push(num);
                successCount++;
            } catch (e) {}
        });
        await Promise.all(batchTasks);
        await delay(100);
    }
    if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);
    bot.sendMessage(chatId, `Done. Sent: ${successCount}`, getKeyboard(chatId));
}

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId) {

    bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        await createUser(chatId.toString(), match[1]);
        bot.sendMessage(chatId, `Welcome to Ultarbot Pro`, getKeyboard(chatId));
    });

    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isAdmin = (userId === ADMIN_ID);

        // PAIRING
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, 'Invalid number.', getKeyboard(chatId));
            }
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing...`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            return;
        }

        // BROADCAST
        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target']; 
            userState[chatId] = null; 
            await executeBroadcast(bot, clients, shortIdMap, chatId, targetId, text);
            return;
        }

        // MENU ACTIONS
        switch (text) {
            case "Connect Account":
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Enter number:', { reply_markup: { force_reply: true } });
                break;

            case "My Account":
            case "My Account":
                const mySessions = await getAllSessions(userId);
                let accMsg = `👤 *My Accounts*\n\n`;
                if (mySessions.length === 0) accMsg += "No active accounts.";
                else {
                    mySessions.forEach(s => {
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         const duration = getDuration(s.connected_at);
                         
                         // ADDED DURATION DISPLAY
                         accMsg += `ID: \`${id}\` | +${s.phone} [ACTIVE]\n`;
                         accMsg += `Duration: ${duration}\n\n`;
                    });
                }
                bot.sendMessage(chatId, accMsg, { parse_mode: 'Markdown', ...getKeyboard(chatId) });
                break;
            
            // ... (Keep other menu cases like Dashboard, Withdraw, etc. from previous step) ...
            case "Dashboard":
                 // ... existing dashboard logic ...
                 break;
            
            // ADMIN ACTIONS
            case "List All":
            case "List All":
                if (!isAdmin) return;
                const allSessions = await getAllSessions(null);
                const totalNums = await countNumbers();
                let list = `[ Total Numbers in DB: ${totalNums} ]\n\n`;
                if (allSessions.length === 0) list += "No accounts.";
                else allSessions.forEach(s => {
                    const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                    const duration = getDuration(s.connected_at);
                    if(id) list += `ID: \`${id}\` | +${s.phone} (Owner: ${s.telegram_user_id})\n⏳ ${duration}\n\n`;
                });
                bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
                break;
        }
    });

    // ... (Rest of commands /antimsg, /report, etc. remain the same) ...
}
