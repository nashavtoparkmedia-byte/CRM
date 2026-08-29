const { Telegraf } = require('telegraf');
const { redactText } = require('./src/security/redactSecrets');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

console.log('Testing bot token...');
bot.telegram.getMe()
    .then((me) => {
        console.log('SUCCESS: Bot is valid!');
        console.log('Bot Name:', me.first_name);
        console.log('Bot Username:', me.username);
        process.exit(0);
    })
    .catch((err) => {
        console.error('FAILURE: Bot token is invalid or network error!');
        console.error(redactText(err.message));
        process.exit(1);
    });
