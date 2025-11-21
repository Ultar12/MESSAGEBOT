import fs from 'fs';
import { delay } from '@whiskeysockets/baileys';
import { 
    addNumbersToDb, getAllNumbers, clearAllNumbers, 
    setAntiMsgStatus, setAutoSaveStatus, countNumbers, deleteNumbers, addToBlacklist,
    getAllSessions, getUser, createUser, getReferrals, updateBank, createWithdrawal
} from './db.js';

const ADMIN_ID = process.env.ADMIN_ID;
const NOTIFICATION_ID = process.env.ADMIN_ID; // Admins gets support msgs

// --- ECONOMY CONFIG ---
const POINTS_PER_HOUR = 10;
const EXCHANGE_RATE = 0.6; // 1 Point = 0.6 NGN (1000 pts = 600 NGN)
const MIN_WITHDRAW = 1000;

const userState = {}; 

// --- KEYBOARDS ---
const userKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🔌 Connect Account" }, { text: "👤 My Account" }],
            [{ text: "📊 Dashboard" }, { text: "👥 Referrals" }],
            [{ text: "💸 Withdraw" }, { text: "📞 Support" }]
        ],
        resize_keyboard: true
    }
};

const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🔌 Connect Account" }, { text: "📂 List All" }],
            [{ text: "📢 Broadcast" }, { text: "🧹 Clear Database" }],
            [{ text: "🕷️ Scrape" }, { text: "🚫 Report" }, { text: "💾 SD Payload" }]
        ],
        resize_keyboard: true
    }
};

function getKeyboard(chatId) {
    return (chatId.toString() === ADMIN_ID) ? adminKeyboard : userKeyboard;
}

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId) {

    // --- 1. START ---
    bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const refCode = match[1]; // Get referral ID if present

        // Register User
        await createUser(chatId.toString(), refCode);

        bot.sendMessage(chatId, 
            `👋 *Welcome to Ultarbot Pro*\n\n` +
            `Earn money by connecting your WhatsApp accounts.\n` +
            `Rate: ${POINTS_PER_HOUR} points/hr per active account.\n` +
            `1000 Points = 600 NGN.\n\n` +
            `Select an option below:`,
            { parse_mode: 'Markdown', ...getKeyboard(chatId) }
        );
    });

    // --- 2. MESSAGE HANDLER ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();

        // A. PAIRING
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, '❌ Invalid number.', getKeyboard(chatId));
            }
            userState[chatId] = null;
            bot.sendMessage(chatId, `⏳ Initializing +${number}...`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            return;
        }

        // B. BANK DETAILS
        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const parts = text.split('|');
            if (parts.length !== 3) {
                return bot.sendMessage(chatId, '❌ Invalid format. Use: Bank Name | Account Number | Account Name');
            }
            await updateBank(userId, parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[chatId] = null;
            bot.sendMessage(chatId, '✅ Bank details saved! Click Withdraw again to process.', getKeyboard(chatId));
            return;
        }

        // C. WITHDRAW AMOUNT
        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            if (isNaN(amount) || amount < MIN_WITHDRAW) {
                return bot.sendMessage(chatId, `❌ Minimum withdrawal is ${MIN_WITHDRAW} points.`);
            }
            
            const user = await getUser(userId);
            if (user.points < amount) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `❌ Insufficient balance. You have ${user.points} points.`);
            }

            const ngnValue = amount * EXCHANGE_RATE;
            const withdrawId = await createWithdrawal(userId, amount, ngnValue);

            // Notify Admin via Notification Bot
            await notificationBot.sendMessage(ADMIN_ID, 
                `💸 *New Withdrawal Request*\n\n` +
                `User: \`${userId}\`\n` +
                `Points: ${amount}\n` +
                `Amount: ₦${ngnValue}\n` +
                `Bank: ${user.bank_name}\n` +
                `Acc: \`${user.account_number}\`\n` +
                `Name: ${user.account_name}\n` +
                `ID: #${withdrawId}`,
                { parse_mode: 'Markdown' }
            );

            userState[chatId] = null;
            bot.sendMessage(chatId, `✅ Withdrawal request #${withdrawId} for ₦${ngnValue} submitted.`, getKeyboard(chatId));
            return;
        }

        // D. SUPPORT MESSAGE
        if (userState[chatId] === 'WAITING_SUPPORT') {
            await notificationBot.sendMessage(ADMIN_ID, 
                `📞 *Support Message*\nFrom: \`${userId}\`\n\n${text}`,
                { parse_mode: 'Markdown' }
            );
            userState[chatId] = null;
            bot.sendMessage(chatId, '✅ Message sent to support.', getKeyboard(chatId));
            return;
        }

        // --- MENU ACTIONS ---
        switch (text) {
            case "🔌 Connect Account":
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter your WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "👤 My Account":
                const mySessions = await getAllSessions(userId);
                let msg = `👤 *My Accounts*\n\n`;
                if (mySessions.length === 0) {
                    msg += "No active accounts.";
                } else {
                    mySessions.forEach(s => {
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         msg += `ID: \`${id}\` | +${s.phone} [ACTIVE]\n`;
                    });
                }
                bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                break;

            case "📊 Dashboard":
                const user = await getUser(userId);
                const activeSessions = await getAllSessions(userId);
                
                bot.sendMessage(chatId, 
                    `📊 *User Dashboard*\n\n` +
                    `💰 *Points:* ${user.points}\n` +
                    `💵 *Value:* ₦${(user.points * EXCHANGE_RATE).toFixed(2)}\n` +
                    `📱 *Active Bots:* ${activeSessions.length}\n\n` +
                    `_You earn ${POINTS_PER_HOUR} points per hour for each active bot._`,
                    { parse_mode: 'Markdown' }
                );
                break;

            case "👥 Referrals":
                const refData = await getReferrals(userId);
                const link = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
                
                let refMsg = `👥 *Referral System*\n\n` +
                             `🔗 Link: \`${link}\`\n\n` +
                             `Total Invited: ${refData.total}\n\n` +
                             `*Recent Joins:*\n`;
                
                if (refData.list.length === 0) refMsg += "None yet.";
                else refData.list.forEach(r => refMsg += `- User ${r.telegram_id}\n`);

                bot.sendMessage(chatId, refMsg, { parse_mode: 'Markdown' });
                break;

            case "💸 Withdraw":
                const wUser = await getUser(userId);
                if (!wUser.bank_name) {
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                    bot.sendMessage(chatId, 
                        `⚠️ *Setup Bank Details*\n\n` +
                        `Please reply in this format:\n` +
                        `Bank Name | Account Number | Account Name\n\n` +
                        `Example: Kuda | 1234567890 | John Doe`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, 
                        `🏦 *Withdraw Funds*\n\n` +
                        `Bank: ${wUser.bank_name}\n` +
                        `Acc: ${wUser.account_number}\n` +
                        `Name: ${wUser.account_name}\n\n` +
                        `Enter amount of points to withdraw (Min ${MIN_WITHDRAW}):`
                    );
                }
                break;

            case "📞 Support":
                userState[chatId] = 'WAITING_SUPPORT';
                bot.sendMessage(chatId, 'Type your message for support:', { reply_markup: { force_reply: true } });
                break;
                
            // --- ADMIN COMMANDS (Only work for Admin ID) ---
            case "📂 List All":
                if (chatId.toString() !== ADMIN_ID) return;
                // ... existing List All logic ...
                break;
        }
    });
}
