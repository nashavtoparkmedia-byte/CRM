const { Markup } = require('telegraf');
const logger = require('../utils/logger');

/**
 * Show the main reply keyboard menu
 * @param {Object} ctx - Telegraf context
 */
function mainMenu(ctx) {
    logger.info('Displaying main menu for user:', ctx.from.id);
    return ctx.reply(
        'Выберите действие:',
        Markup.keyboard([
            ['🛠 Поддержка'],
            ['📊 Опрос качества'],
            ['📖 Информация'],
            ['🚖 Yandex Taxi Fun']
        ])
            .resize()
            .oneTime(false) // Changed to false to keep menu visible
    );
}

/**
 * Handle menu button presses
 * @param {Object} ctx - Telegraf context
 * @param {Object} surveyHandler - Reference to survey handler to start survey
 */
async function handleMenu(ctx, surveyHandler) {
    const text = ctx.message.text;
    logger.info(`Menu action: "${text}" from user: ${ctx.from.id}`);

    switch (text) {
        case '🛠 Поддержка':
            await ctx.reply('🧑‍💻 *Техподдержка*\n\nНапишите нам: @yokopark\nРаботаем 24/7', { parse_mode: 'Markdown' });
            break;
        case '📊 Опрос качества':
            // Trigger the existing survey scene
            if (surveyHandler && surveyHandler.handleStartSurvey) {
                await surveyHandler.handleStartSurvey(ctx);
            } else {
                await ctx.reply('Начнем опрос качества...');
            }
            break;
        case '📖 Информация':
            const infoText = `
📖 *Информация о сервисе*

Мы помогаем водителям и партнерам улучшать качество сервиса через обратную связь.
Ваши ответы помогают нам стать лучше!

Техподдержка: @yokopark
            `;
            await ctx.reply(infoText, { parse_mode: 'Markdown' });
            break;
        case '🚖 Yandex Taxi Fun':
            await ctx.reply('Перейти в канал:', Markup.inlineKeyboard([
                Markup.button.url('Открыть канал', 'https://t.me/yandex_taxi_fun')
            ]));
            break;
        default:
            await ctx.reply('Выберите пункт меню выше.');
    }
}

module.exports = { mainMenu, handleMenu };
