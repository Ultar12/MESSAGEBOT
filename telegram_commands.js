import fs from 'fs';
import path from 'path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

// Configuration
const NUMBERS_FILE = './numbers.json';
const VCF_FILE = './contacts.vcf';

// Helper: Extract Numbers from VCF Content
function parseVcf(vcfContent) {
    const numbers = new Set(); 
    const regex = /TEL;?[^:]*:(?:[\+]?)([\d\s-]+)/gi;
    let match;
    while ((match = regex.exec(vcfContent)) !== null) {
        let cleanNum = match[1].replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) numbers.add(cleanNum);
    }
    return Array.from(numbers);
}

export function setupTelegramCommands(bot, clients, SESSIONS_DIR, startClient, makeSessionId, antiMsgState) {

    // --- 1. START ---
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, 
            '🤖 *Ultarbot Command Center*\n\n' +
            '/pair <number> - Connect WhatsApp\n' +
            '/list - View active sessions\n' +
            '/generate <code 234> <amount> - Create numbers\n' +
            '/save - Reply to .vcf to load contacts\n' +
            '/broadcast - Reply to text to BLAST message\n' +
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

    // --- 5. SAVE VCF ---
    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(msg.chat.id, '❌ Please reply to a VCF file with /save');
        }

        const doc = msg.reply_to_message.document;
        // Basic check for VCF extension
        if (!doc.file_name.toLowerCase().endsWith('.vcf') && !doc.mime_type.includes('vcard')) {
            return bot.sendMessage(msg.chat.id, '❌ This does not look like a VCF file.');
        }

        try {
            const fileLink = await bot.getFileLink(doc.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();

            fs.writeFileSync(VCF_FILE, text);
            const numbers = parseVcf(text);
            
            bot.sendMessage(msg.chat.id, `✅ VCF Saved!\nFound ${numbers.length} unique contacts.\nReady to /broadcast.`);
        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error saving VCF: ${e.message}`);
        }
    });

    // --- 6. BROADCAST / SEND (PARALLEL MODE) ---
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

        // B. MASS BROADCAST (IMMEDIATE MODE)
        if (msg.reply_to_message && msg.reply_to_message.text) {
            let numbers = [];
            let source = '';

            // 1. Try VCF
            if (fs.existsSync(VCF_FILE)) {
                const vcfContent = fs.readFileSync(VCF_FILE, 'utf-8');
                numbers = parseVcf(vcfContent);
                source = 'VCF File';
            } 
            // 2. Try JSON
            else if (fs.existsSync(NUMBERS_FILE)) {
                numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
                source = 'Random List';
            } else {
                return bot.sendMessage(chatId, '❌ No contact list found. Upload a .vcf with /save or use /generate.');
            }

            if (numbers.length === 0) return bot.sendMessage(chatId, '❌ List is empty.');

            bot.sendMessage(chatId, `🚀 BLASTING message to ${numbers.length} numbers (Instant Mode)...`);

            // --- PARALLEL EXECUTION LOGIC ---
            // This maps every number to a sending task and fires them ALL AT ONCE.
            const broadcastTasks = numbers.map(async (num, index) => {
                // Round-robin client selection
                const sock = activeClients[index % activeClients.length];
                
                // Skip if client is locked
                const senderPhone = jidNormalizedUser(sock.user?.id).split('@')[0];
                if (antiMsgState[senderPhone]) return { status: 'skipped', num };

                try {
                    const jid = `${num}@s.whatsapp.net`;
                    // Note: We SKIP 'onWhatsApp' check to make it instant.
                    // If the number is invalid, it will just fail silently.
                    await sock.sendMessage(jid, { text: msg.reply_to_message.text });
                    return { status: 'sent', num };
                } catch (e) {
                    return { status: 'failed', num };
                }
            });

            // Wait for all to finish (happens very fast)
            const results = await Promise.allSettled(broadcastTasks);

            // Calculate stats
            const sentCount = results.filter(r => r.status === 'fulfilled' && r.value.status === 'sent').length;
            const failCount = results.length - sentCount;

            bot.sendMessage(chatId, `✅ Broadcast Done.\nSent: ${sentCount}\nFailed/Skipped: ${failCount}`);
            return;
        }

        bot.sendMessage(chatId, 'Usage:\nReply to a message with /broadcast to send to all instantly.');
    };

    bot.onText(/\/send/, (msg) => handleBroadcast(msg, false));
    bot.onText(/\/broadcast/, (msg) => handleBroadcast(msg, true));
}
