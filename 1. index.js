import TelegramBot from "node-telegram-bot-api";

// Telegram Bot setup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const chatId = process.env.TELEGRAM_CHAT_ID;

// Demo function - इथे नंतर Solana/Raydium detection logic add होईल
function newCoinDetected(coin) {
  bot.sendMessage(chatId, `🚀 New coin detected: ${coin}`);
}

// फक्त test साठी 5 सेकंदांनी alert
setInterval(() => {
  newCoinDetected("TEST-COIN");
}, 5000);

console.log("Sniper Bot is running...");
