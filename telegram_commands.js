import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { delay } from '@whiskeysockets/baileys';
import { addNumbersToDb, getAllNumbers, clearAllNumbers, setAntiMsgStatus, setAutoSaveStatus, countNumbers, deleteNumbers, addToBlacklist, getAllSessions } from './db.js';

const ADMIN_ID = process.env.ADMIN_ID;
const userState = {}; 

// EMAIL CONFIG
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendReportEmail(targetNumber) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return "Email not configured";

    const jid = `${targetNumber}@s.whatsapp.net`;
    const time = new Date().toISOString();

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: 'support@whatsapp.com',
        subject: `Report: Spam Activity - +${targetNumber}`,
        text: `Hello WhatsApp Support,\n\nReporting account for Terms of Service violation.\n\nPhone: +${targetNumber}\nJID: ${jid}\nTime: ${time}\n\nThis account is sending unsolicited automated messages.\n`
    };

    try {
        await transporter.sendMail(mailOptions);
        return "Email Sent";
    } catch (error) {
        return `Email Failed: ${error.message}`;
    }
}

// --- KEYBOARDS ---

const userKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Pair Account" }, { text: "My Accounts" }]
        ],
        resize_keyboard: true
    }
};

const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Pair Account" }, { text: "List All" }],
            [{ text: "Broadcast" }, { text: "Clear Contact List" }],
            [{ text: "Scrape" }, { text: "Report" }, { text: "SD Payload" }]
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
    const BATCH_SIZE = 10; 
    const messageBase = messageText.trim();
    
    // Turbo Batch Sending (Sequential Flash)
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        const batchTasks = batch.map(async (num) => {
            // Anti-Ban Hash Breaker
            const stealthPayload = messageBase + '\u200B'.repeat(1) + Math.random().toString(36).substring(2, 5); 
            
            try {
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

        // --- PAIRING INPUT LISTENER (FIXED) ---
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
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter the WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "My Accounts":
            case "List All":
                const targetUserId = text === "My Accounts" ? chatId.toString() : null; // Admin sees all if 'List All'
                const sessions = await getAllSessions(targetUserId);
                
                let list = "";
                if (isUserAdmin && text === "List All") {
                    const totalNumbers = await countNumbers();
                    list += `[ Total Numbers in DB: ${totalNumbers} ]\n\n`;
                    list += "--- ALL CONNECTED ACCOUNTS ---\n";
                } else {
                    list += "--- YOUR ACCOUNTS ---\n";
                }

                if (sessions.length === 0) {
                    list += "No accounts connected.";
                } else {
                    sessions.forEach(session => {
                        const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === session.session_id);
                        if (!id) return; 

                        const antiStatus = session.antimsg ? "LOCKED" : "UNLOCKED";
                        const saveStatus = session.autosave ? "AUTOSAVE" : "MANUAL";
                        const owner = isUserAdmin && session.telegram_user_id ? ` (Owner: ${session.telegram_user_id})` : '';

                        list += `ID: \`${id}\` | +${session.phone}\n[${antiStatus}] [${saveStatus}]${owner}\n\n`;
                    });
                }
                bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
                break;

            case "Clear Contact List": 
                if (!isUserAdmin) return;
                await clearAllNumbers();
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Contact list cleared from database.", currentKeyboard);
                break;

            case "Broadcast":
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === chatId.toString());
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.", currentKeyboard);
                
                const autoId = activeIds[0];
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = autoId;
                
                bot.sendMessage(chatId, `Using Account ID: \`${autoId}\`\n\nPlease enter the message to broadcast:`, { parse_mode: 'Markdown' });
                break;
            
            // --- ADMIN-ONLY COMMANDS ---
            case "Scrape":
            case "Report":
            case "SD Payload":
                if (!isUserAdmin) return; 
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
            const payload = fs.readFileSync('./sd.js', 'utf-8');
            
            if (!payload || payload.trim().length === 0) {
                return bot.sendMessage(chatId, "Error: sd.js content is empty.");
            }

            bot.sendMessage(chatId, `Sending Payload to +${targetNumber}...`);
            
            const jid = `${targetNumber}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: payload });
            
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
}
