import fs from 'fs';
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
            [{ text: "Scrape" }, { text: "Report" }, { text: "SD Payload" }]
        ],
        resize_keyboard: true
    }
};

function getKeyboard(chatId) {
    return (chatId.toString() === ADMIN_ID) ? adminKeyboard : userKeyboard;
}

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId) {

    // --- START ---
    bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const refCode = match[1];

        await createUser(chatId.toString(), refCode);
        const user = await getUser(chatId.toString());

        if (user && user.is_banned) return bot.sendMessage(chatId, "You are banned from using this bot.");

        bot.sendMessage(chatId, 
            `Welcome to Ultarbot Pro\n\n` +
            `Earn money by connecting your WhatsApp accounts.\n` +
            `Rate: ${POINTS_PER_HOUR} points/hr per account.\n` +
            `1000 Points = 600 NGN.\n\n` +
            `Select an option below:`,
            { ...getKeyboard(chatId) }
        );
    });

    // --- MESSAGE HANDLER ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isAdmin = (userId === ADMIN_ID);

        const user = await getUser(userId);
        if (user && user.is_banned && !isAdmin) return;

        // A. PAIRING
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

        // B. BANK DETAILS
        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const parts = text.split('|');
            if (parts.length !== 3) return bot.sendMessage(chatId, 'Invalid format. Use: Bank | Account | Name');
            
            await updateBank(userId, parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[chatId] = null;
            bot.sendMessage(chatId, 'Bank details saved! Click Withdraw again.', getKeyboard(chatId));
            return;
        }

        // C. WITHDRAW AMOUNT
        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            if (isNaN(amount) || amount < MIN_WITHDRAW) return bot.sendMessage(chatId, `Minimum withdrawal is ${MIN_WITHDRAW} points.`);
            
            if (user.points < amount) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `Insufficient balance.`);
            }

            const ngnValue = amount * EXCHANGE_RATE;
            const withdrawId = await createWithdrawal(userId, amount, ngnValue);

            await notificationBot.sendMessage(ADMIN_ID, 
                `[NEW WITHDRAWAL]\n` +
                `User: \`${userId}\`\n` +
                `Points: ${amount}\n` +
                `Amount: NGN ${ngnValue}\n` +
                `Bank: ${user.bank_name}\n` +
                `Acc: ${user.account_number}\n` +
                `Name: ${user.account_name}\n` +
                `ID: #${withdrawId}`
            );

            userState[chatId] = null;
            bot.sendMessage(chatId, `Withdrawal #${withdrawId} submitted.`, getKeyboard(chatId));
            return;
        }

        // D. SUPPORT
        if (userState[chatId] === 'WAITING_SUPPORT') {
            await notificationBot.sendMessage(ADMIN_ID, `[SUPPORT]\nFrom: \`${userId}\`\n\n${text}`);
            userState[chatId] = null;
            bot.sendMessage(chatId, 'Message sent to support.', getKeyboard(chatId));
            return;
        }

        // --- MENU ---
        switch (text) {
            case "Connect Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Enter your WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "My Account":
                const mySessions = await getAllSessions(userId);
                let accMsg = `My Accounts\n\n`;
                if (mySessions.length === 0) accMsg += "No active accounts.";
                else {
                    mySessions.forEach(s => {
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         accMsg += `ID: \`${id}\` | +${s.phone} [ACTIVE]\n`;
                    });
                }
                bot.sendMessage(chatId, accMsg, { parse_mode: 'Markdown' });
                break;

            case "Dashboard":
                const stats = await getEarningsStats(userId);
                const activeSessions = await getAllSessions(userId);
                const refInfo = await getReferrals(userId);
                
                bot.sendMessage(chatId, 
                    `User Dashboard\n\n` +
                    `Points: ${user.points}\n` +
                    `Value: NGN ${(user.points * EXCHANGE_RATE).toFixed(2)}\n` +
                    `Referral Earnings: ${user.referral_earnings} pts\n` +
                    `Active Bots: ${activeSessions.length}\n\n` +
                    `Task Earnings:\n` +
                    `Today: ${stats.today} pts\n` +
                    `Yesterday: ${stats.yesterday} pts`,
                    { 
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "History: Earnings", callback_data: "hist_earn" }],
                                [{ text: "History: Withdrawals", callback_data: "hist_with" }]
                            ]
                        }
                    }
                );
                break;

            case "Referrals":
                const refData = await getReferrals(userId);
                const link = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
                
                let refMsg = `Referral System\n\n` +
                             `Link: \`${link}\`\n\n` +
                             `Total Invited: ${refData.total}\n` +
                             `Commission: 20%\n\n` +
                             `Recent Joins:\n`;
                
                if (refData.list.length === 0) refMsg += "None yet.";
                else refData.list.forEach(r => refMsg += `- ${r.telegram_id}\n`);

                bot.sendMessage(chatId, refMsg, { parse_mode: 'Markdown' });
                break;

            case "Withdraw":
                if (!user.bank_name) {
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                    bot.sendMessage(chatId, `Send bank details:\nBank | Account | Name`);
                } else {
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount to withdraw (Min ${MIN_WITHDRAW}):`);
                }
                break;

            case "Support":
                userState[chatId] = 'WAITING_SUPPORT';
                bot.sendMessage(chatId, 'Type your message:', { reply_markup: { force_reply: true } });
                break;

            // --- ADMIN ONLY ---
            case "List All":
                if (!isAdmin) return;
                const sessions = await getAllSessions(null);
                let list = `All Accounts\n\n`;
                sessions.forEach(s => list += `+${s.phone} (Owner: ${s.telegram_user_id})\n`);
                bot.sendMessage(chatId, list || "None");
                break;
        }
    });

    // --- HISTORY CALLBACKS ---
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
        if (data === 'hist_with') {
            const history = await getHistory(userId, 'WITHDRAWAL');
            let msg = "Withdrawal History\n\n";
            history.forEach(h => msg += `${h.created_at.toISOString().split('T')[0]}: ${h.amount_points} pts -> NGN ${h.amount_ngn} [${h.status}]\n`);
            bot.sendMessage(chatId, msg || "No history.");
        }
        bot.answerCallbackQuery(query.id);
    });

    // --- ADMIN BAN COMMANDS ---
    bot.onText(/\/ban (\d+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const targetId = match[1];
        await banUser(targetId, true);
        bot.sendMessage(msg.chat.id, `User ${targetId} BANNED.`);
    });

    bot.onText(/\/unban (\d+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const targetId = match[1];
        await banUser(targetId, false);
        bot.sendMessage(msg.chat.id, `User ${targetId} UNBANNED.`);
    });
}
