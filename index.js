// Entry point for the Telegram bot
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { handlePair, handleSend, handleGenerate, handleSave } from './whatsappManager.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.command('pair', async (ctx) => {
	try {
		await handlePair(ctx);
	} catch (e) {
		ctx.reply('Error during pairing: ' + (e.message || e));
	}
});

bot.command('send', async (ctx) => {
	try {
		await handleSend(ctx);
	} catch (e) {
		ctx.reply('Error during sending: ' + (e.message || e));
	}
});

bot.command('generate', async (ctx) => {
	try {
		await handleGenerate(ctx);
	} catch (e) {
		ctx.reply('Error during number generation: ' + (e.message || e));
	}
});

bot.command('save', async (ctx) => {
	try {
		await handleSave(ctx);
	} catch (e) {
		ctx.reply('Error during VCF save: ' + (e.message || e));
	}
});

// Use webhook if TELEGRAM_WEBHOOK_URL is set, otherwise fallback to polling
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
if (webhookUrl) {
	bot.launch({
		webhook: {
			domain: webhookUrl,
			port: process.env.PORT || 3000
		}
	});
	console.log('Telegram bot started with webhook at ' + webhookUrl);
} else {
	bot.launch();
	console.log('Telegram bot started with polling.');
}
