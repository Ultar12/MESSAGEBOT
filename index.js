// Entry point for the Telegram bot
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { handlePair, handleSend, handleGenerate, handleSave } from './whatsappManager.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.command('pair', async (ctx) => {
	await handlePair(ctx);
});

bot.command('send', async (ctx) => {
	await handleSend(ctx);
});

bot.command('generate', async (ctx) => {
	await handleGenerate(ctx);
});

bot.command('save', async (ctx) => {
	await handleSave(ctx);
});

bot.launch();
console.log('Telegram bot started.');
