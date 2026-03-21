const { Scenes, Markup } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const userService = require('../services/userService');
const sheetsService = require('../services/sheets');
const logger = require('../utils/logger');
const config = require('../config');

const prisma = new PrismaClient();

/**
 * Dynamic Survey Scene
 * Fetches questions from DB and handles both linear and branching logic.
 */
const dynamicSurveyScene = new Scenes.BaseScene('survey');

dynamicSurveyScene.enter(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;

        // 1. Fetch the requested survey
        const surveyId = ctx.session.activeSurveyId;
        if (!surveyId) {
            console.error('[DYNAMIC SURVEY] No activeSurveyId found in session context');
            await ctx.reply('К сожалению, этот опрос недоступен.');
            return ctx.scene.leave();
        }

        const survey = await prisma.survey.findUnique({
            where: { id: surveyId },
            include: {
                questions: { orderBy: { order: 'asc' } }
            }
        });

        if (!survey || !survey.questions || survey.questions.length === 0) {
            console.log(`[DYNAMIC SURVEY] Config missing for survey ${surveyId}. Survey found: ${!!survey}, Questions count: ${survey?.questions?.length || 0}`);
            await ctx.reply('К сожалению, опрос пока не настроен. Пожалуйста, попробуйте позже.');
            return ctx.scene.leave();
        }

        console.log(`[DYNAMIC SURVEY] Found survey ${survey.id} with ${survey.questions.length} questions`);

        // 2. Initialize state
        ctx.session.survey = {
            id: survey.id,
            isLinear: survey.isLinear,
            questions: survey.questions,
            responses: {},
            currentIndex: 0
        };

        // 3. Log start and update status
        await userService.setUserState(userId, 'SURVEY');
        await sheetsService.upsertUserRow(userId, username, { 'Status': 'Started Survey' });
        await userService.logAction(userId, username, 'START_DYNAMIC_SURVEY', { surveyId: survey.id });

        // --- NEW: Track SURVEY_STARTED ---
        try {
            const botToken = config.botToken.trim();
            const botDb = await prisma.bot.findFirst({ where: { token: botToken } });
            if (botDb) {
                const dbUser = await prisma.user.findFirst({
                    where: { botId: botDb.id, telegramId: BigInt(userId) }
                });

                await prisma.analyticsEvent.create({
                    data: {
                        botId: botDb.id,
                        userId: dbUser ? dbUser.id : null,
                        eventType: 'SURVEY_STARTED',
                        sourceId: survey.id
                    }
                });
                console.log(`[Analytics] Tracked SURVEY_STARTED for userId ${userId} on survey ${survey.id}`);
            }
        } catch (analyticsErr) {
            console.error('Failed to log SURVEY_STARTED event:', analyticsErr.message);
        }

        // 4. Send first question
        return askQuestion(ctx);

    } catch (err) {
        console.error('[DYNAMIC SURVEY ERROR]:', err);
        logger.error('Error entering dynamic survey:', err);

        // Detailed log of what's happening
        if (err.code === 'P2002') console.error('Prisma Unique constraint failed');

        await ctx.reply(`Произошла ошибка при запуске опроса: ${err.message || 'Неизвестная ошибка'}`);
        await userService.setUserState(ctx.from.id, 'IDLE');
        return ctx.scene.leave();
    }
});

/**
 * Common function to display the current question
 */
async function askQuestion(ctx) {
    const { questions, currentIndex } = ctx.session.survey;
    const q = questions[currentIndex];

    let keyboard = Markup.keyboard([['🔙 Меню']]).resize();

    if (q.type === 'BUTTONS' && q.options && q.options.length > 0) {
        // Create rows of 2 buttons
        const buttonRows = [];
        for (let i = 0; i < q.options.length; i += 2) {
            buttonRows.push(q.options.slice(i, i + 2));
        }
        buttonRows.push(['🔙 Меню']);
        keyboard = Markup.keyboard(buttonRows).resize();
    }

    await ctx.reply(q.text, keyboard);
}

/**
 * Handle incoming messages
 */
dynamicSurveyScene.on('message', async (ctx) => {
    try {
        const text = ctx.message?.text;
        const userId = ctx.from.id;
        const username = ctx.from.username;

        if (!text) {
            return await ctx.reply('Пожалуйста, используйте текст или кнопки для ответа.');
        }

        if (text === '🔙 Меню') {
            const startHandler = require('./start');
            return await startHandler.showMainMenu(ctx);
        }

        const { questions, currentIndex, isLinear, responses } = ctx.session.survey;
        const currentQ = questions[currentIndex];

        // 1. Validate answer if mandatory (MVP assumes text is sufficient)
        responses[currentQ.id] = text;

        // 2. Determine next step
        let nextIndex = -1;

        if (!isLinear && currentQ.type === 'BUTTONS' && currentQ.routingRules) {
            // Branching logic
            const rule = currentQ.routingRules.find(r => r.if_answer === text);
            if (rule) {
                if (rule.next_question_id === 'END') {
                    return finishSurvey(ctx);
                }
                nextIndex = questions.findIndex(q => q.id === rule.next_question_id);
            }
        }

        // If linear or no matching rule found
        if (nextIndex === -1) {
            nextIndex = currentIndex + 1;
        }

        // 3. Check if done
        if (nextIndex >= questions.length || nextIndex === -1) {
            return finishSurvey(ctx);
        }

        // 4. Move to next
        ctx.session.survey.currentIndex = nextIndex;
        return askQuestion(ctx);

    } catch (err) {
        logger.error('Error in dynamic survey message handler:', err);
        await ctx.reply(`Произошла ошибка: ${err.message}. Опрос завершен досрочно.`);
        await userService.setUserState(ctx.from.id, 'IDLE');
        return ctx.scene.leave();
    }
});

/**
 * Finalize Survey
 */
async function finishSurvey(ctx) {
    const { responses, questions } = ctx.session.survey;
    const userId = ctx.from.id;
    const username = ctx.from.username;

    // Map responses to sheet columns (Header: Q1, Q2, etc or based on question text)
    const exportData = {
        'Status': 'Completed Survey'
    };

    questions.forEach((q, idx) => {
        const answer = responses[q.id] || 'N/A';
        exportData[`Q${idx + 1}`] = answer;
    });

    try {
        await sheetsService.upsertUserRow(userId, username, exportData);
        await userService.logAction(userId, username, 'DYNAMIC_SURVEY_COMPLETE', { responses });

        // Save to PostgreSQL via Prisma for the Admin Panel
        const botToken = config.botToken.trim();
        let botDb = await prisma.bot.findFirst({ where: { token: botToken } });

        if (!botDb) {
            logger.info(`Bot mapping not found in DB for token ${botToken}. Auto-creating it.`);
            botDb = await prisma.bot.create({
                data: {
                    token: botToken,
                    name: config.botName || 'Auto Bot',
                    surveys: { create: {} }
                }
            });
        }

        if (botDb) {
            const dbUser = await prisma.user.upsert({
                where: {
                    botId_telegramId: {
                        botId: botDb.id,
                        telegramId: BigInt(userId)
                    }
                },
                update: {
                    status: 'COMPLETED',
                    username: username,
                    firstName: ctx.from?.first_name || ''
                },
                create: {
                    botId: botDb.id,
                    telegramId: BigInt(userId),
                    username: username,
                    firstName: ctx.from?.first_name || '',
                    status: 'COMPLETED'
                }
            });

            // Delete old answers if user retakes THIS SPECIFIC survey
            const currentSurveyQuestionIds = questions.map(q => q.id);
            if (currentSurveyQuestionIds.length > 0) {
                await prisma.answer.deleteMany({
                    where: {
                        userId: dbUser.id,
                        questionId: { in: currentSurveyQuestionIds }
                    }
                });
            }

            // Insert new answers
            for (const q of questions) {
                const answerValue = responses[q.id];
                if (answerValue !== undefined) {
                    await prisma.answer.create({
                        data: {
                            userId: dbUser.id,
                            questionId: q.id,
                            value: String(answerValue)
                        }
                    });
                }
            }

            // --- NEW: Track SURVEY_COMPLETED ---
            try {
                await prisma.analyticsEvent.create({
                    data: {
                        botId: botDb.id,
                        userId: dbUser.id,
                        eventType: 'SURVEY_COMPLETED',
                        sourceId: ctx.session.survey.id,
                        metadata: responses
                    }
                });
                console.log(`[Analytics] Tracked SURVEY_COMPLETED for user ${dbUser.id} on survey ${ctx.session.survey.id}`);
            } catch (analyticsErr) {
                console.error('Failed to log SURVEY_COMPLETED event:', analyticsErr.message);
            }
        }
    } catch (err) {
        logger.error('Failed to sync dynamic survey completion:', err.message);
    }

    await ctx.reply('Спасибо за ваши ответы! Опрос завершен.');

    const startHandler = require('./start');
    await startHandler.showMainMenu(ctx);
    return ctx.scene.leave();
}

/**
 * Entry point for the survey button
 */
async function handleStartSurvey(ctx) {
    try {
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
        }
        await ctx.scene.enter('survey');
    } catch (err) {
        logger.error('Error in handleStartSurvey:', err);
        await ctx.reply('Не удалось запустить опрос. Пожалуйста, попробуйте позже.');
    }
}

module.exports = {
    dynamicSurveyScene,
    handleStartSurvey
};
