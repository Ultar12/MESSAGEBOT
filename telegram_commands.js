import fs from 'fs';
import nodemailer from 'nodemailer';
import { delay } from '@whiskeysockets/baileys';
import { addNumbersToDb, getAllNumbers, clearAllNumbers, setAntiMsgStatus, setAutoSaveStatus, countNumbers, deleteNumbers, addToBlacklist } from './db.js';

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

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Pair Account" }, { text: "List Active" }],
            // RENAMED BUTTON HERE:
            [{ text: "Broadcast" }, { text: "Clear Contact List" }] 
        ],
        resize_keyboard: true
    }
};

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

async function executeBroadcast(bot, clients, shortIdMap, chatId, targetId, messageText) {
    const sessionData = shortIdMap[targetId];
    if (!sessionData || !clients[sessionData.folder]) {
        return bot.sendMessage(chatId, 'Client disconnected or invalid ID.', mainKeyboard);
    }

    const sock = clients[sessionData.folder];
    const numbers = await getAllNumbers();

    if (numbers.length === 0) return bot.sendMessage(chatId, 'Contact list is empty.', mainKeyboard);

    bot.sendMessage(chatId, `Turbo-Flashing message to ${numbers.length} contacts using ID ${targetId}...`);
    
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
        `Sent: ${successCount}\n` +
        `Contacts Removed: ${successfulNumbers.length}`, 
        mainKeyboard
    );
}

export function setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, autoSaveState) {

    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        bot.sendMessage(msg.chat.id, 'Ultarbot Pro Active.', mainKeyboard);
    });

    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;

        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return bot.sendMessage(chatId, 'Invalid number.');

            const existing = Object.values(shortIdMap).find(s => s.phone === number);
            if (existing) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `Account +${number} is already connected.`, mainKeyboard);
            }

            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}... Please wait for code.`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId);
            return;
        }

        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target']; 
            userState[chatId] = null; 
            await executeBroadcast(bot, clients, shortIdMap, chatId, targetId, text);
            return;
        }

        switch (text) {
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter the WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "List Active":
                const ids = Object.keys(shortIdMap);
                const totalNumbers = await countNumbers();
                let list = `[ Total Numbers in DB: ${totalNumbers} ]\n\n`;
                if (ids.length === 0) {
                    list += "No accounts connected.";
                } else {
                    list += "Active Sessions:\n";
                    ids.forEach(id => {
                        const session = shortIdMap[id];
                        const antiStatus = antiMsgState[id] ? "LOCKED" : "UNLOCKED";
                        const saveStatus = autoSaveState[id] ? "AUTOSAVE" : "MANUAL";
                        list += `ID: \`${id}\` | +${session.phone}\n[${antiStatus}] [${saveStatus}]\n\n`;
                    });
                }
                bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
                break;

            // UPDATED CASE NAME
            case "Clear Contact List": 
                await clearAllNumbers();
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Contact list cleared from database.", mainKeyboard);
                break;

            case "Broadcast":
                const activeIds = Object.keys(shortIdMap);
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.", mainKeyboard);
                
                const autoId = activeIds[0];
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = autoId;
                
                bot.sendMessage(chatId, `Using Account ID: \`${autoId}\`\n\nPlease enter the message to broadcast:`, { parse_mode: 'Markdown' });
                break;
        }
    });

    bot.onText(/\/report (.+)/, async (msg, match) => {
        const rawNumber = match[1].replace(/[^0-9]/g, '');
        if (rawNumber.length < 7) return bot.sendMessage(msg.chat.id, "Invalid number.");

        await addToBlacklist(rawNumber);

        const activeIds = Object.keys(shortIdMap);
        if (activeIds.length === 0) return bot.sendMessage(msg.chat.id, "No accounts connected.");

        bot.sendMessage(msg.chat.id, `Executing Network Block & Report on +${rawNumber}...`);

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

        bot.sendMessage(msg.chat.id, 
            `[REPORT SUCCESS]\n` +
            `Target: +${rawNumber}\n` +
            `Blocked: ${blockedCount}\n` +
            `Email: ${emailStatus}\n` +
            `Added to Blacklist.`
        );
    });

    bot.onText(/\/scrape (.+)/, async (msg, match) => {
        const link = match[1];
        const chatId = msg.chat.id;
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
                if (jid.includes('@s.whatsapp.net')) {
                    const num = jid.split('@')[0];
                    if (num.length >= 7 && num.length <= 15 && !isNaN(num)) validNumbers.push(num);
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

    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
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
        const id = match[1].trim();
        const action = match[2].toLowerCase();
        if (!shortIdMap[id]) return bot.sendMessage(msg.chat.id, `Invalid ID.`);

        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');
        autoSaveState[id] = newState;
        await setAutoSaveStatus(sessionId, newState);

        bot.sendMessage(msg.chat.id, `AutoSave for \`${id}\` is now ${action.toUpperCase()}.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/generate (.+)/, async (msg, match) => {
        const args = msg.text.split(' ');
        const code = args[1];
        const amount = parseInt(args[2], 10) || 100;
        
        const newNumbers = [];
        for (let i = 0; i < amount; i++) newNumbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
        
        await addNumbersToDb(newNumbers);
        const total = await countNumbers();
        bot.sendMessage(msg.chat.id, `Added ${amount} numbers. (Total: ${total})`);
    });

    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message?.document) return;
        
        const firstId = Object.keys(shortIdMap)[0];
        if (!firstId || !clients[shortIdMap[firstId].folder]) return bot.sendMessage(msg.chat.id, 'Pair an account first.');
        const sock = clients[shortIdMap[firstId].folder];

        try {
            bot.sendMessage(msg.chat.id, "Downloading...");
            const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();
            
            const rawNumbers = parseVcf(text);
            bot.sendMessage(msg.chat.id, `Scanning ${rawNumbers.length} numbers...`);

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
            let listMsg = `Saved ${validNumbers.length} numbers.\nTotal Database: ${total}\n\nNew Numbers:\n`;
            if (validNumbers.length > 300) listMsg += validNumbers.slice(0, 300).join('\n') + `\n...and ${validNumbers.length - 300} more.`;
            else listMsg += validNumbers.join('\n');

            bot.sendMessage(msg.chat.id, listMsg);
        } catch (e) {
            bot.sendMessage(msg.chat.id, "Error: " + e.message);
        }
    });
}
