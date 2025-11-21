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

// --- KEYBOARDS ---

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

// FIXED ADMIN KEYBOARD: Removed Dashboard/Withdraw
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Connect Account" }, { text: "List All" }],
            [{ text: "Broadcast" }, { text: "Clear Contact List" }]
        ],
        resize_keyboard: true
    }
};

function getKeyboard(chatId) {
    return (chatId.toString() === ADMIN_ID) ? adminKeyboard : userKeyboard;
}

// --- UTILITY ---
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

// --- MAIN LOGIC ---

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
    const messageBase = messageText.trim();
    
    // Turbo Batch Sending (Sequential Flash)
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        const batchTasks = batch.map(async (num) => {
            // Anti-Ban Hash Breaker
            const stealthPayload = messageBase + '\u200B'.repeat(1) + Math.random().toString(36).substring(2, 5); 
            
            try {
                // Use random micro-delay to simulate human interaction variance
                await delay(Math.floor(Math.random() * 50)); 
                
                // Use a generic text message type (simplest)
                await sock.sendMessage(`${num}@s.whatsapp.net`, { text: stealthPayload });
                successfulNumbers.push(num);
                successCount++;
            } catch (e) {}
        });
        await Promise.all(batchTasks);
        await delay(1000); // 1 second micro-wait between batches
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

    // --- BASE HANDLER: /start and general message routing ---

    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        bot.sendMessage(msg.chat.id, 'Welcome to Ultarbot Pro.', getKeyboard(msg.chat.id));
    });

    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const isUserAdmin = (chatId.toString() === ADMIN_ID);
        const currentKeyboard = getKeyboard(chatId);

        // --- PAIRING INPUT LISTENER ---
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, 'Invalid number.', currentKeyboard);
            }
            
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}... Please wait for code.`);
            const sessionId = makeSessionId();
            // Pass the user's Telegram ID here
            startClient(sessionId, number, chatId, chatId.toString()); 
            return;
        }

        // --- BROADCAST MESSAGE INPUT LISTENER ---
        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target']; 
            userState[chatId] = null; 
            await executeBroadcast(bot, clients, shortIdMap, chatId, targetId, text);
            return;
        }

        // --- MAIN MENU ROUTER ---
        switch (text) {
            case "Connect Account":
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter the WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "My Account":
                // User-only view
                const mySessions = await getAllSessions(chatId.toString());
                let accMsg = `My Accounts\n\n`;
                if (mySessions.length === 0) accMsg += "No active accounts.";
                else {
                    mySessions.forEach(s => {
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         const duration = getDuration(s.connected_at);
                         if(id) accMsg += `ID: \`${id}\` | +${s.phone} [ACTIVE]\n⏳ Duration: ${duration}\n\n`;
                    });
                }
                bot.sendMessage(chatId, accMsg, { parse_mode: 'Markdown' });
                break;

            // --- ADMIN LIST ---
            case "List All":
                if (!isUserAdmin) return;
                const sessions = await getAllSessions(null);
                const totalNumbers = await countNumbers();
                
                let list = `[ Total Numbers in DB: ${totalNumbers} ]\n\n`; // Header

                if (sessions.length === 0) {
                    list += "No connected accounts.";
                } else {
                    sessions.forEach(session => {
                        const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === session.session_id);
                        if (!id) return; 

                        const antiStatus = session.antimsg ? "LOCKED" : "UNLOCKED";
                        const saveStatus = session.autosave ? "AUTOSAVE" : "MANUAL";
                        const owner = isUserAdmin && session.telegram_user_id ? ` (Owner: ${session.telegram_user_id})` : '';
                        const duration = getDuration(session.connected_at);

                        list += `ID: \`${id}\` | +${session.phone}\n[${antiStatus}] [${saveStatus}]${owner}\n⏳ ${duration}\n\n`;
                    });
                }
                bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
                break;
            
            // --- USER COMMANDS ---
            case "Dashboard":
                if (isUserAdmin) return; // Admin has no dashboard
                const stats = await getEarningsStats(userId);
                const activeSessions = await getAllSessions(userId);
                const user = await getUser(userId);
                bot.sendMessage(chatId, 
                    `User Dashboard\n\nPoints: ${user.points}\nValue: NGN ${(user.points * EXCHANGE_RATE).toFixed(2)}\nActive Bots: ${activeSessions.length}\n\nToday: ${stats.today} pts`,
                    { reply_markup: { inline_keyboard: [[{ text: "History", callback_data: "hist_earn" }]] } }
                );
                break;

            case "Referrals":
                if (isUserAdmin) return;
                const refData = await getReferrals(userId);
                const link = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;
                bot.sendMessage(chatId, `Referral System\n\nLink: \`${link}\`\nTotal Invited: ${refData.total}`, { parse_mode: 'Markdown' });
                break;

            case "Withdraw":
                if (isUserAdmin) return; // Admin cannot withdraw
                const wUser = await getUser(userId);
                if (!wUser.bank_name) {
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                    bot.sendMessage(chatId, `Send bank details:\nBank | Account | Name`);
                } else {
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount to withdraw (Min ${MIN_WITHDRAW}):`);
                }
                break;

            case "Support":
                if (isUserAdmin) return;
                userState[chatId] = 'WAITING_SUPPORT';
                bot.sendMessage(chatId, 'Type your message:', { reply_markup: { force_reply: true } });
                break;

            // --- ADMIN COMMANDS ---
            case "Clear Contact List": 
                if (!isUserAdmin) return;
                await clearAllNumbers();
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Contact list cleared from database.", currentKeyboard);
                break;

            case "Broadcast":
                if (!isUserAdmin) return;
                const activeIds = Object.keys(shortIdMap);
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.", currentKeyboard);
                
                const autoId = activeIds[0];
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = autoId;
                
                bot.sendMessage(chatId, `Using Account ID: \`${autoId}\`\n\nPlease enter the message to broadcast:`, { parse_mode: 'Markdown' });
                break;
            
            // --- ADMIN-ONLY HIDDEN COMMANDS ---
            case "Scrape":
            case "Report":
            case "SD Payload":
                if (!isUserAdmin) return; // Fall-through to admin commands logic below (if triggered by text)
        }
    });

    // --- COMMANDS (Admin and Functional) ---

    // SD COMMAND (READS PAYLOAD AS TEXT)
    bot.onText(/\/sd\s+([a-zA-Z0-9]+)\s+(\d+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_ID) return;
        
        const targetId = match[1].trim();
        const targetNumber = match[2].trim();

        if (!shortIdMap[targetId]) return bot.sendMessage(chatId, `Invalid ID: ${targetId}`);
        
        const sock = clients[shortIdMap[targetId].folder];
        if (!sock) return bot.sendMessage(chatId, `Account ${targetId} is disconnected.`);

        try {
            // Read sd.js as a plain text file (UTF-8)
            const payload = fs.readFileSync('./sd.js', 'utf-8');
            if (!payload || payload.trim().length === 0) return bot.sendMessage(chatId, "Error: sd.js content is empty.");

            bot.sendMessage(chatId, `Sending Payload to +${targetNumber}...`);
            const jid = `${targetNumber}@s.whatsapp.net`;
            const stealthPayload = payload + '\u200B'.repeat(1) + Math.random().toString(36).substring(2, 5); 

            await sock.sendMessage(jid, { text: stealthPayload });
            bot.sendMessage(chatId, `Payload Sent.`);

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, `SD Error: Failed to read sd.js or send payload. Make sure sd.js exists.`);
        }
    });

    // REPORT COMMAND
    bot.onText(/\/report (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_ID) return;
        
        const rawNumber = match[1].replace(/[^0-9]/g, '');
        if (rawNumber.length < 7) return bot.sendMessage(chatId, "Invalid number.");

        await addToBlacklist(rawNumber);

        const activeIds = Object.keys(shortIdMap);
        if (activeIds.length === 0) return bot.sendMessage(chatId, "No accounts connected.");

        bot.sendMessage(chatId, `Executing Network Block & Report on +${rawNumber}...`);

        let blockedCount = 0;
        const jid = `${rawNumber}@s.whatsapp.net`;

        for (const id of activeIds) {
            const session = shortIdMap[id];
            const sock = clients[session.folder];
            if (sock) {
                try {
                    await sock.updateBlockStatus(jid, "block");
                    blockedCount++;
                } catch (e) {}
            }
        }

        const emailStatus = await sendReportEmail(rawNumber);

        bot.sendMessage(chatId, 
            `[REPORT SUCCESS]\n` +
            `Target: +${rawNumber}\n` +
            `Blocked: ${blockedCount}\n` +
            `Email: ${emailStatus}\n` +
            `Added to Blacklist.`
        );
    });

    // SCRAPE COMMAND
    bot.onText(/\/scrape (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_ID) return;

        const link = match[1];
        const firstId = Object.keys(shortIdMap)[0];
        if (!firstId || !clients[shortIdMap[firstId].folder]) return bot.sendMessage(chatId, 'Pair account first.');
        const sock = clients[shortIdMap[firstId].folder];

        const regex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/;
        const codeMatch = link.match(regex);
        if (!codeMatch) return bot.sendMessage(chatId, 'Invalid Link.');
        const code = codeMatch[1];

        let groupJid = null;
        try {
            bot.sendMessage(chatId, 'Processing Group...');
            const inviteInfo = await sock.groupGetInviteInfo(code);
            groupJid = inviteInfo.id;
            const groupSubject = inviteInfo.subject || "Unknown Group";

            try { await sock.groupAcceptInvite(code); } catch (e) {}
            
            const metadata = await sock.groupMetadata(groupJid);
            const validNumbers = [];
            let lidCount = 0;

            metadata.participants.forEach(p => {
                const jid = p.id;
                if (jid.includes('@s.whatsapp.net') && jid.split('@')[0].length <= 15) {
                    const num = jid.split('@')[0];
                    if (!isNaN(num)) validNumbers.push(num);
                } else {
                    lidCount++;
                }
            });
            
            if (validNumbers.length === 0) {
                bot.sendMessage(chatId, `Only found ${lidCount} hidden IDs (LIDs). No numbers.`);
            } else {
                let vcfContent = "";
                validNumbers.forEach(num => {
                    vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:WA ${num}\nTEL;TYPE=CELL:+${num}\nEND:VCARD\n`;
                });

                const fileName = `Group_${groupSubject.replace(/[^a-zA-Z0-9]/g, '_')}.vcf`;
                fs.writeFileSync(fileName, vcfContent);

                await bot.sendDocument(chatId, fileName, {
                    caption: `[SCRAPE SUCCESS]\nGroup: ${groupSubject}\nFound Numbers: ${validNumbers.length}\nLIDs: ${lidCount}`
                });
                fs.unlinkSync(fileName);
            }
        } catch (e) {
            bot.sendMessage(chatId, `Scrape Failed: ${e.message}`);
        } finally {
            if (groupJid) try { await sock.groupLeave(groupJid); } catch (e) {}
        }
    });

    // SETTINGS COMMANDS (antimsg, autosave)
    bot.onText(/\/(antimsg|autosave)\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_ID) return;

        const command = match[1].toLowerCase();
        const id = match[2].trim();
        const action = match[3].toLowerCase();

        if (!shortIdMap[id]) return bot.sendMessage(chatId, `Invalid ID.`);

        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');
        
        if (command === 'antimsg') {
            antiMsgState[id] = newState;
            await setAntiMsgStatus(sessionId, newState);
        } else if (command === 'autosave') {
            autoSaveState[id] = newState;
            await setAutoSaveStatus(sessionId, newState);
        }

        bot.sendMessage(chatId, `${command.toUpperCase()} for \`${id}\` is now ${action.toUpperCase()}.`, { parse_mode: 'Markdown' });
    });

    // USER: BANK DETAILS
    bot.on('message', async (msg) => {
        if (userState[msg.chat.id] === 'WAITING_BANK_DETAILS' && msg.text) {
            const parts = msg.text.split('|');
            if (parts.length !== 3) return bot.sendMessage(msg.chat.id, 'Invalid format. Use: Bank | Account | Name');
            await updateBank(msg.chat.id.toString(), parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[msg.chat.id] = null;
            bot.sendMessage(msg.chat.id, 'Bank details saved!', getKeyboard(msg.chat.id));
        }
        else if (userState[msg.chat.id] === 'WAITING_WITHDRAW_AMOUNT' && msg.text) {
            const amount = parseInt(msg.text);
            const user = await getUser(msg.chat.id.toString());
            if (isNaN(amount) || amount < MIN_WITHDRAW) return bot.sendMessage(msg.chat.id, `Min withdrawal: ${MIN_WITHDRAW} pts.`);
            if (user.points < amount) return bot.sendMessage(msg.chat.id, `Insufficient balance.`);
            const ngnValue = amount * EXCHANGE_RATE;
            const withdrawId = await createWithdrawal(msg.chat.id.toString(), amount, ngnValue);
            await notificationBot.sendMessage(ADMIN_ID, `[NEW WITHDRAWAL]\nUser: ${msg.chat.id}\nAmount: NGN ${ngnValue}`);
            userState[msg.chat.id] = null;
            bot.sendMessage(msg.chat.id, `Withdrawal #${withdrawId} submitted.`, getKeyboard(msg.chat.id));
        }
        else if (userState[msg.chat.id] === 'WAITING_SUPPORT' && msg.text) {
            await notificationBot.sendMessage(ADMIN_ID, `[SUPPORT]\nFrom: ${msg.chat.id}\n\n${msg.text}`);
            userState[msg.chat.id] = null;
            bot.sendMessage(msg.chat.id, 'Message sent.', getKeyboard(msg.chat.id));
        }
    });
}
