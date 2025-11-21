import fs from 'fs';
import path from 'path';
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

// CONFIG
const POINTS_PER_HOUR = 10;
const EXCHANGE_RATE = 0.6; 
const MIN_WITHDRAW = 1000;

// EMAIL CONFIG
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function sendReportEmail(targetNumber) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return "Email not configured";
    const jid = `${targetNumber}@s.whatsapp.net`;
    const time = new Date().toISOString();
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: 'support@whatsapp.com',
        subject: `Report: Spam Activity - +${targetNumber}`,
        text: `Hello WhatsApp Support,\n\nReporting account +${targetNumber} (JID: ${jid}) for spam at ${time}.\n`
    };
    try { await transporter.sendMail(mailOptions); return "Email Sent"; } catch (error) { return `Email Failed: ${error.message}`; }
}

// KEYBOARDS
const userKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Connect Account" }, { text: "My Account" }],
            [{ text: "Dashboard" }, { text: "Referrals" }],
            [{ text: "Withdraw" }, { text: "Support" }]
        ],
        resize_keyboard: true
    }
};

const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Connect Account" }, { text: "List All" }],
            [{ text: "Broadcast" }, { text: "Clear Contact List" }],
            [{ text: "Dashboard" }, { text: "Withdraw" }]
        ],
        resize_keyboard: true
    }
};

function getKeyboard(chatId) {
    return (chatId.toString() === ADMIN_ID) ? adminKeyboard : userKeyboard;
}

// UTILITY
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
    return duration.trim() || "Just now";
}

// BROADCAST LOGIC
async function executeBroadcast(bot, clients, shortIdMap, chatId, targetId, messageText) {
    const sessionData = shortIdMap[targetId];
    if (!sessionData || !clients[sessionData.folder]) {
        return bot.sendMessage(chatId, 'Client disconnected or invalid ID.', getKeyboard(chatId));
    }
    const sock = clients[sessionData.folder];
    const numbers = await getAllNumbers();
    if (numbers.length === 0) return bot.sendMessage(chatId, 'Contact list is empty.', getKeyboard(chatId));

    bot.sendMessage(chatId, `Turbo-Flashing message to ${numbers.length} contacts using ID \`${targetId}\`...`);
    
    let successCount = 0;
    const startTime = Date.now();
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
    const duration = (Date.now() - startTime) / 1000;
    if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

    bot.sendMessage(chatId, 
        `Flash Complete in ${duration}s.\n` +
        `Sent Requests: ${successCount}\n` +
        `Contacts Removed: ${successfulNumbers.length}`, 
        getKeyboard(chatId)
    );
}

export function setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, autoSaveState) {

    bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const refCode = match[1];
        await createUser(chatId.toString(), refCode);
        const user = await getUser(chatId.toString());
        if (user && user.is_banned) return bot.sendMessage(chatId, "You are banned.");

        bot.sendMessage(chatId, 
            `Welcome to Ultarbot Pro\nEarn money by connecting your WhatsApp accounts.\nSelect an option below:`,
            { ...getKeyboard(chatId) }
        );
    });

    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isAdmin = (userId === ADMIN_ID);
        const user = await getUser(userId);
        
        if (user && user.is_banned && !isAdmin) return;

        // PAIRING INPUT
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, 'Invalid number.', getKeyboard(chatId));
            }
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}...`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            return;
        }

        // BROADCAST INPUT
        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target']; 
            userState[chatId] = null; 
            await executeBroadcast(bot, clients, shortIdMap, chatId, targetId, text);
            return;
        }

        // BANK DETAILS
        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const parts = text.split('|');
            if (parts.length !== 3) return bot.sendMessage(chatId, 'Invalid format. Use: Bank | Account | Name');
            await updateBank(userId, parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[chatId] = null;
            bot.sendMessage(chatId, 'Bank details saved!', getKeyboard(chatId));
            return;
        }

        // WITHDRAW AMOUNT
        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            if (isNaN(amount) || amount < MIN_WITHDRAW) return bot.sendMessage(chatId, `Min withdrawal: ${MIN_WITHDRAW} pts.`);
            if (user.points < amount) return bot.sendMessage(chatId, `Insufficient balance.`);
            const ngnValue = amount * EXCHANGE_RATE;
            const withdrawId = await createWithdrawal(userId, amount, ngnValue);
            bot.sendMessage(ADMIN_ID, `[NEW WITHDRAWAL]\nUser: ${userId}\nAmount: NGN ${ngnValue}`);
            userState[chatId] = null;
            bot.sendMessage(chatId, `Withdrawal #${withdrawId} submitted.`, getKeyboard(chatId));
            return;
        }

        // SUPPORT
        if (userState[chatId] === 'WAITING_SUPPORT') {
            bot.sendMessage(ADMIN_ID, `[SUPPORT]\nFrom: ${userId}\n\n${text}`);
            userState[chatId] = null;
            bot.sendMessage(chatId, 'Message sent.', getKeyboard(chatId));
            return;
        }

        // MENU ACTIONS
        switch (text) {
            case "Connect Account":
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Enter your WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "My Account":
            case "List All":
                const targetUserId = text === "My Account" ? userId : null;
                const mySessions = await getAllSessions(targetUserId);
                
                let accMsg = text === "My Account" ? `My Accounts\n\n` : `All Accounts\n\n`;
                if (mySessions.length === 0) accMsg += "No active accounts.";
                else {
                    mySessions.forEach(s => {
                         // Find short ID from memory map (loaded from DB on boot)
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         
                         // If shortIdMap is empty for this session (e.g. fresh restart), get from DB manually is tricky
                         // But boot() populates shortIdMap, so it should be there.
                         
                         const duration = getDuration(s.connected_at);
                         const anti = s.antimsg ? "LOCKED" : "UNLOCKED";
                         
                         if(id) {
                             accMsg += `ID: \`${id}\` | +${s.phone}\nState: [${anti}]\nDuration: ${duration}\n\n`;
                         }
                    });
                }
                bot.sendMessage(chatId, accMsg, { parse_mode: 'Markdown' });
                break;

            case "Dashboard":
                const stats = await getEarningsStats(userId);
                const activeSessions = await getAllSessions(userId);
                bot.sendMessage(chatId, 
                    `User Dashboard\n\nPoints: ${user.points}\nValue: NGN ${(user.points * EXCHANGE_RATE).toFixed(2)}\nActive Bots: ${activeSessions.length}\n\nToday: ${stats.today} pts`,
                    { reply_markup: { inline_keyboard: [[{ text: "History", callback_data: "hist_earn" }]] } }
                );
                break;

            case "Referrals":
                const refData = await getReferrals(userId);
                const link = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
                bot.sendMessage(chatId, `Referral System\n\nLink: \`${link}\`\nTotal Invited: ${refData.total}`, { parse_mode: 'Markdown' });
                break;

            case "Withdraw":
                if (!user.bank_name) {
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                    bot.sendMessage(chatId, `Send bank details:\nBank | Account | Name`);
                } else {
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount (Min ${MIN_WITHDRAW}):`);
                }
                break;

            case "Support":
                userState[chatId] = 'WAITING_SUPPORT';
                bot.sendMessage(chatId, 'Type message:', { reply_markup: { force_reply: true } });
                break;
                
            case "Clear Contact List":
                if (!isAdmin) return;
                await clearAllNumbers();
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Contact list cleared.");
                break;
                
            case "Broadcast":
                const activeIds = isAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === chatId.toString());
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.", getKeyboard(chatId));
                
                const autoId = activeIds[0];
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = autoId;
                bot.sendMessage(chatId, `Using Account ID: \`${autoId}\`\n\nPlease enter the message to broadcast:`, { parse_mode: 'Markdown' });
                break;
        }
    });

    // COMMANDS
    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const id = match[1].trim();
        const action = match[2].toLowerCase();
        if (!shortIdMap[id]) return bot.sendMessage(msg.chat.id, `Invalid ID.`);
        
        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');
        antiMsgState[id] = newState;
        await setAntiMsgStatus(sessionId, newState);
        bot.sendMessage(msg.chat.id, `AntiMsg for \`${id}\` is now ${action.toUpperCase()}.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/autosave\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const id = match[1].trim();
        const action = match[2].toLowerCase();
        if (!shortIdMap[id]) return bot.sendMessage(msg.chat.id, `Invalid ID.`);
        
        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');
        autoSaveState[id] = newState;
        await setAutoSaveStatus(sessionId, newState);
        bot.sendMessage(msg.chat.id, `AutoSave for \`${id}\` is now ${action.toUpperCase()}.`, { parse_mode: 'Markdown' });
    });
    
    // ... (Keep SD, Report, Scrape, Ban logic here as implemented previously) ...
    
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const userId = chatId.toString();
        const data = query.data;
        if (data === 'hist_earn') {
            const history = await getHistory(userId, 'TASK');
            let msg = "Earnings History\n\n";
            history.forEach(h => msg += `${h.created_at.toISOString().split('T')[0]}: +${h.amount} (${h.type})\n`);
            bot.sendMessage(chatId, msg || "No history.");
        }
        bot.answerCallbackQuery(query.id);
    });
}
