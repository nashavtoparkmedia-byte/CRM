const { Scenes, Markup } = require('telegraf');
const userService = require('../services/userService');
const sheetsService = require('../services/sheets');
const logger = require('../utils/logger');

const { WizardScene } = Scenes;

// Remove reply keyboard for survey
const removeKeyboard = Markup.removeKeyboard();

// Helper to check if survey should continue
async function shouldContinue(ctx) {
    const userId = ctx.from.id;
    const state = await userService.getUserState(userId);
    if (state !== 'SURVEY') {
        const startHandler = require('./start');
        await startHandler.showMainMenu(ctx);
        return false;
    }
    return true;
}

// Survey wizard scene with updated YOKO park questions flow
const surveyWizard = new WizardScene(
    'survey',
    // Step 1: Full Name collection
    async (ctx) => {
        try {
            const userId = ctx.from.id;
            const username = ctx.from.username;

            // Mark user state as SURVEY
            await userService.setUserState(userId, 'SURVEY');

            // Log and Update status
            await sheetsService.upsertUserRow(userId, username, { 'Status': 'Started Survey' });

            await ctx.reply(
                'Добрый день! Это Екатерина, парк YOKO. Перед началом опроса, пожалуйста, напишите вашу Фамилию, Имя и Отчество полностью.',
                Markup.keyboard([['🔙 Меню']]).resize()
            );
            return ctx.wizard.next();
        } catch (err) {
            logger.error('Error in survey step 1:', err);
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }
    },
    // Step 2: Handle Full Name and ask for Phone
    async (ctx) => {
        try {
            if (!(await shouldContinue(ctx))) return;

            const text = ctx.message?.text;

            // Basic FIO validation
            if (!text || text.split(' ').length < 2) {
                await ctx.reply('Пожалуйста, введите ваше ФИО полностью (минимум Фамилия и Имя).');
                return;
            }

            ctx.wizard.state.fullName = text;
            const userId = ctx.from.id;

            await userService.updateUser(userId, { full_name: text });

            await ctx.reply(
                'Отлично! Теперь, пожалуйста, поделитесь вашим номером телефона для идентификации.',
                Markup.keyboard([
                    [Markup.button.contactRequest('📱 Поделиться номером')],
                    ['🔙 Меню']
                ]).resize()
            );
            return ctx.wizard.next();
        } catch (err) {
            logger.error('Error in survey step 2:', err);
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }
    },
    // Step 3: Handle Phone and ask Q1
    async (ctx) => {
        try {
            if (!(await shouldContinue(ctx))) return;

            const contact = ctx.message?.contact;
            const text = ctx.message?.text;
            let phone = '';

            if (contact) {
                phone = contact.phone_number;
            } else if (text && text.includes('+') && text.length > 10) {
                phone = text;
            } else {
                await ctx.reply('Пожалуйста, используйте кнопку "Поделиться номером" или введите номер вручную в формате +7999...');
                return;
            }

            ctx.wizard.state.phone = phone;
            const userId = ctx.from.id;
            await userService.updateUser(userId, { phone: phone });

            await ctx.reply(
                'Хотим узнать, как у вас дела, всё ли удобно в работе. Есть ли какие-то сложности с Яндексом, где мы могли бы помочь?',
                Markup.keyboard([['🔙 Меню']]).resize()
            );
            return ctx.wizard.next();
        } catch (err) {
            logger.error('Error in survey step 3:', err);
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }
    },
    // Step 4: Q2 - Missing features
    async (ctx) => {
        try {
            if (!(await shouldContinue(ctx))) return;

            const text = ctx.message?.text;
            if (!text) {
                await ctx.reply('Пожалуйста, введите текстовый ответ.');
                return;
            }

            ctx.wizard.state.workSituation = text;
            await ctx.reply('Есть ли что-то, чего вам не хватает со стороны парка — например, в удобстве выплат, общении или поддержке?');
            return ctx.wizard.next();
        } catch (err) {
            logger.error('Error in survey step 4:', err);
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }
    },
    // Step 5: Q3 - Recommendation
    async (ctx) => {
        try {
            if (!(await shouldContinue(ctx))) return;

            const text = ctx.message?.text;
            if (!text) {
                await ctx.reply('Пожалуйста, введите текстовый ответ.');
                return;
            }

            ctx.wizard.state.missingFeatures = text;
            await ctx.reply('Насколько вероятно, что вы посоветуете наш парк знакомым? (от 1 до 10)');
            return ctx.wizard.next();
        } catch (err) {
            logger.error('Error in survey step 5:', err);
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }
    },
    // Step 6: Finalization
    async (ctx) => {
        try {
            if (!(await shouldContinue(ctx))) return;

            const text = ctx.message?.text;
            if (!text) {
                await ctx.reply('Пожалуйста, введите текстовый ответ.');
                return;
            }

            ctx.wizard.state.recommendation = text;

            const {
                fullName,
                phone,
                workSituation,
                missingFeatures,
                recommendation
            } = ctx.wizard.state;

            const userId = ctx.from.id;
            const username = ctx.from.username;

            // Final local sync
            await userService.logAction(userId, username, 'SURVEY_COMPLETE', ctx.wizard.state);

            // Update Google Sheets with full results
            try {
                await sheetsService.upsertUserRow(userId, username, {
                    'Full Name': fullName,
                    'Phone': phone,
                    'Status': 'Completed Survey',
                    'Q1_Intro': workSituation,
                    'Q2_WorkSituation': workSituation, // User previously mapped Intro to q1
                    'Q3_MissingFeatures': missingFeatures,
                    'Q4_Recommendation': recommendation
                });
            } catch (err) {
                logger.error('Failed to update sheets on completion:', err.message);
            }

            await ctx.reply(
                'Спасибо за ваши ответы! Нам важно, чтобы вам было комфортно. Всегда можете обращаться, если что-то понадобится.'
            );

            // Success and back to menu
            const startHandler = require('./start');
            await ctx.reply('✅ Опрос завершён!');
            await startHandler.showMainMenu(ctx);

            return ctx.scene.leave();
        } catch (err) {
            logger.error('Error in survey step 6:', err);
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }
    }
);

// Handle START_SURVEY button (now checks phone first in start.js)
async function handleStartSurvey(ctx) {
    try {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery('Запускаем опрос...');
        }
        const userId = ctx.from.id;
        const username = ctx.from.username;

        console.log(`[ENTER SURVEY] ${userId}`);
        await userService.logAction(userId, username, 'START_SURVEY');

        // Ensure state is set to SURVEY
        await userService.setUserState(userId, 'SURVEY');

        await ctx.scene.enter('survey');
        return;
    } catch (err) {
        logger.error('Error in START_SURVEY handler:', err);
    }
}

module.exports = {
    surveyWizard,
    handleStartSurvey
};
