const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegramService');
const sheetsService = require('../services/sheets');

router.post('/:botToken', async (req, res) => {
    const { botToken } = req.params;
    const prisma = req.prisma;
    const update = req.body;

    // Telegram expects 200 OK immediately to acknowledge receipt, 
    // otherwise it will retry sending the webhook.
    res.status(200).send('OK');

    try {
        // 1. Validate Bot
        const bot = await prisma.bot.findUnique({
            where: { token: botToken },
            include: { surveys: { where: { isActive: true }, take: 1 } }
        });

        if (!bot || !bot.isActive) {
            console.warn(`[Webhook] Received update for inactive/unknown bot token: ${botToken.substring(0, 10)}...`);
            return;
        }

        const survey = bot.surveys?.[0];
        if (!survey || !survey.isActive) {
            // Handled silently or we could send a fallback message if we had telegram ID context early enough.
            return;
        }

        // 2. Extract Message/Callback Info
        let telegramId, text, isCallback = false;
        let username, firstName;

        if (update.message) {
            telegramId = update.message.chat.id;
            text = update.message.text;
            username = update.message.from.username;
            firstName = update.message.from.first_name;
        } else if (update.callback_query) {
            telegramId = update.callback_query.message.chat.id;
            text = update.callback_query.data;
            username = update.callback_query.from.username;
            firstName = update.callback_query.from.first_name;
            isCallback = true;
        } else {
            // Ignored update type
            return;
        }

        // 3. Find or Create User
        let user = await prisma.user.findUnique({
            where: {
                botId_telegramId: { botId: bot.id, telegramId: BigInt(telegramId) }
            }
        });

        if (!user) {
            user = await prisma.user.create({
                data: {
                    botId: bot.id,
                    telegramId: BigInt(telegramId),
                    username: username,
                    firstName: firstName,
                    status: 'ACTIVE'
                }
            });
        }

        // Handle /start or restart
        if (text === '/start') {
            const firstQuestion = await prisma.question.findFirst({
                where: { surveyId: survey.id },
                orderBy: { order: 'asc' }
            });

            if (!firstQuestion) {
                await telegramService.sendMessage(botToken, telegramId, "Опрос пока не настроен.");
                return;
            }

            await prisma.user.update({
                where: { id: user.id },
                data: { currentQuestionId: firstQuestion.id, status: 'ACTIVE' }
            });

            await sendQuestion(botToken, telegramId, firstQuestion);
            return;
        }

        // 4. Handle Active Survey Flow
        if (user.status === 'COMPLETED') {
            await telegramService.sendMessage(botToken, telegramId, "Вы уже завершили этот опрос. Спасибо!");
            return;
        }

        if (!user.currentQuestionId) {
            // User is active but has no current question (e.g., they didn't hit /start yet)
            await telegramService.sendMessage(botToken, telegramId, "Пожалуйста, отправьте /start для начала опроса.");
            return;
        }

        // Get Current Question
        const currentQuestion = await prisma.question.findUnique({
            where: { id: user.currentQuestionId }
        });

        if (!currentQuestion) {
            console.error(`[Webhook] User ${user.id} has invalid currentQuestionId ${user.currentQuestionId}`);
            await telegramService.sendMessage(botToken, telegramId, "Произошла ошибка, опрос сломан.");
            return;
        }

        // 5. Save Answer
        await prisma.answer.create({
            data: {
                userId: user.id,
                questionId: currentQuestion.id,
                value: text
            }
        });

        // 6. Compute Next Question based on routing_rules
        let nextQuestionId = null;
        let rules = currentQuestion.routingRules;

        if (rules && Array.isArray(rules)) {
            // Search for specific condition
            const rule = rules.find(r => r.if_answer === text);
            if (rule && rule.next_question_id) {
                nextQuestionId = rule.next_question_id;
            } else {
                // Fallback to default
                const defaultRule = rules.find(r => r.default_next);
                if (defaultRule) {
                    nextQuestionId = defaultRule.default_next;
                }
            }
        }

        // If no routing rule matched, just get the next question by order
        if (!nextQuestionId) {
            const nextQ = await prisma.question.findFirst({
                where: {
                    surveyId: survey.id,
                    order: { gt: currentQuestion.order }
                },
                orderBy: { order: 'asc' }
            });
            if (nextQ) nextQuestionId = nextQ.id;
        }

        if (nextQuestionId) {
            // Advance to next question
            const nextQuestion = await prisma.question.findUnique({ where: { id: nextQuestionId } });
            await prisma.user.update({
                where: { id: user.id },
                data: { currentQuestionId: nextQuestionId }
            });

            await sendQuestion(botToken, telegramId, nextQuestion);
        } else {
            // Survey Complete
            await prisma.user.update({
                where: { id: user.id },
                data: { status: 'COMPLETED', currentQuestionId: null }
            });
            await telegramService.sendMessage(botToken, telegramId, "Опрос завершён. Спасибо за ответы!");

            // TODO: Trigger Google Sheets async export here if syncMode is ON_COMPLETE
        }

    } catch (error) {
        console.error('[Webhook] Unhandled Error processing update:', error);
    }
});

async function sendQuestion(botToken, chatId, question) {
    let replyMarkup = undefined;

    if (question.type === 'BUTTONS' || question.type === 'SELECT') {
        const options = typeof question.options === 'string' ? JSON.parse(question.options) : question.options;
        replyMarkup = telegramService.formatInlineKeyboard(options);
    }

    await telegramService.sendMessage(botToken, chatId, question.text, {
        reply_markup: replyMarkup
    });
}

module.exports = router;
