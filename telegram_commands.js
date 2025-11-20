import fs from 'fs';
import path from 'path';
import { delay } from '@whiskeysockets/baileys';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

// Configuration
const NUMBERS_FILE = './numbers.json';
const VCF_FILE = './contacts.vcf';

// Helper: Extract Numbers from VCF Content
function parseVcf(vcfContent) {
    const numbers = new Set(); // Use Set to automatically remove duplicates
    
    // Regex to find phone numbers in VCF (TEL lines)
    const regex = /TEL;?[^:]*:(?:[\+]?)([\d\s-]+)/gi;
    
    let match;
    while ((match = regex.exec(vcfContent)) !== null) {
        // Clean number: remove spaces, dashes, plus signs
        let cleanNum = match[1].replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) { // Basic validation
            numbers.add(cleanNum);
        }
    }
    return Array.from(numbers);
}

export function setupTelegramCommands(bot, clients, SESSIONS_DIR, startClient, makeSessionId, antiMsgState) {

    // --- 1. START ---
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, 
            '🤖 *Ultarbot Command Center*\n\n' +
            '⚡ *Connection*\n' +
            '/pair <number> - Connect WhatsApp\n' +
            '/list - View active sessions\n\n' +
            '📂 *Contact Management*\n' +
            '/generate <code 234> <amount> - Create random numbers\n' +
            '/save - Reply to a .vcf file to load contacts\n\n' +
            '📨 *Messaging*\n' +
            '/broadcast - Reply to text to send to VCF/JSON list\n' +
            '/send <number> <msg> - Direct message',
            { parse_mode: 'Markdown' }
        );
    });

    // --- 2. PAIRING ---
    bot.onText(/\/pair (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const number = match[1].replace(/[^0-9]/g, '');
        if (!number) return bot.sendMessage(chatId, 'Usage: /pair 2349012345678');
        
        if (clients[number]) return bot.sendMessage(chatId, `+${number} is already connected.`);

        const sessionId = makeSessionId();
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        
        fs.mkdirSync(sessionPath, { recursive: true });

        bot.sendMessage(chatId, `Initializing +${number}...\nSession ID: ${sessionId}`);
        startClient(sessionId, number, chatId);
    });

    // --- 3. LIST ---
    bot.onText(/\/list/, (msg) => {
        const active = Object.keys(clients);
        if (active.length === 0) return bot.sendMessage(msg.chat.id, "No WhatsApp numbers connected.");
        
        let listText = "🟢 *Connected Clients:*\n";
        active.forEach((num, i) => {
            const status = antiMsgState[num] ? "🔒 LOCKED" : "✅ ACTIVE";
            listText += `${i + 1}. +${num} [${status}]\n`;
        });
        bot.sendMessage(msg.chat.id, listText, { parse_mode: 'Markdown' });
    });

    // --- 4. GENERATE NUMBERS ---
    bot.onText(/\/generate (.+)/, (msg, match) => {
        const args = msg.text.split(' ');
        const code = args[1];
        const amount = parseInt(args[2], 10) || 100;
        if (!code) return bot.sendMessage(msg.chat.id, 'Usage: /generate 234 50');
        
        const numbers = [];
        for (let i = 0; i < amount; i++) {
            numbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
        }
        fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
        bot.sendMessage(msg.chat.id, `✅ Generated ${amount} random numbers.`);
    });

    // --- 5. SAVE VCF (New Feature) ---
    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(msg.chat.id, '❌ Please reply to a VCF file with /save');
        }

        const doc = msg.reply_to_message.document;
        if (!doc.mime_type.includes('vcard') && !doc.file_name.endsWith('.vcf')) {
            return bot.sendMessage(msg.chat.id, '❌ This does not look like a VCF file.');
        }

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();

            // Save Raw File
            fs.writeFileSync(VCF_FILE, text);
            
            // Count Numbers
            const numbers = parseVcf(text);
            
            bot.sendMessage(msg.chat.id, `✅ VCF Saved!\nFound ${numbers.length} unique contacts.\nReady to /broadcast.`);
        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error saving VCF: ${e.message}`);
        }
    });

    // --- 6. BROADCAST / SEND ---
    // Handles both direct /send and reply /broadcast
    const handleBroadcast = async (msg, isBroadcastCmd) => {
        const chatId = msg.chat.id;
        const activeClients = Object.values(clients);
        
        if (activeClients.length === 0) return bot.sendMessage(chatId, '❌ No WhatsApp connected. Use /pair first.');

        // A. DIRECT MESSAGE (/send number text)
        if (!msg.reply_to_message && !isBroadcastCmd) {
            const directMatch = msg.text.match(/\/send\s+(\d+)\s+(.+)/);
            if (directMatch) {
                const targetNumber = directMatch[1];
                const messageContent = directMatch[2];
                const sock = activeClients[0]; 
                
                // Check AntiMsg Lock
                const senderPhone = jidNormalizedUser(sock.user?.id).split('@')[0];
                if (antiMsgState[senderPhone]) return bot.sendMessage(chatId, `❌ Locked (AntiMsg ON).`);

                try {
                    await sock.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: messageContent });
                    bot.sendMessage(chatId, `✅ Sent to ${targetNumber}`);
                } catch (e) {
                    bot.sendMessage(chatId, `❌ Failed: ${e.message}`);
                }
                return;
            }
        }

        // B. MASS BROADCAST (Reply with /broadcast or /send)
        if (msg.reply_to_message && msg.reply_to_message.text) {
            let numbers = [];
            let source = '';

            // 1. Try VCF First
            if (fs.existsSync(VCF_FILE)) {
                const vcfContent = fs.readFileSync(VCF_FILE, 'utf-8');
                numbers = parseVcf(vcfContent);
                source = 'VCF File';
            } 
            // 2. Try JSON Second
            else if (fs.existsSync(NUMBERS_FILE)) {
                numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
                source = 'Random List';
            } else {
                return bot.sendMessage(chatId, '❌ No contact list found. Upload a .vcf with /save or use /generate.');
            }

            if (numbers.length === 0) return bot.sendMessage(chatId, '❌ List is empty.');

            bot.sendMessage(chatId, `🚀 Broadcasting to ${numbers.length} numbers from ${source}...`);

            let sent = 0, failed = 0, clientIndex = 0;
            
            // Non-blocking loop
            (async () => {
                for (const num of numbers) {
                    // Rotate clients
                    const sock = activeClients[clientIndex];
                    clientIndex = (clientIndex + 1) % activeClients.length;
                    
                    // Skip locked clients
                    const senderPhone = jidNormalizedUser(sock.user?.id).split('@')[0];
                    if (antiMsgState[senderPhone]) continue;

                    try {
                        const jid = `${num}@s.whatsapp.net`;
                        const [result] = await sock.onWhatsApp(jid);

                        if (result?.exists) {
                            await sock.sendMessage(jid, { text: msg.reply_to_message.text });
                            sent++;
                            // Random delay 2-5 seconds to be safe
                            await delay(Math.random() * 3000 + 2000); 
                        } else {
                            failed++;
                        }
                    } catch (e) {
                        failed++;
                    }
                }
                bot.sendMessage(chatId, `✅ Broadcast Complete.\nSent: ${sent}\nFailed/Invalid: ${failed}`);
            })();
            return;
        }

        bot.sendMessage(chatId, 'Usage:\nReply to a message with /broadcast to send to all.');
    };

    // Trigger logic for both commands
    bot.onText(/\/send/, (msg) => handleBroadcast(msg, false));
    bot.onText(/\/broadcast/, (msg) => handleBroadcast(msg, true));
            }
