const { Markup } = require('telegraf');
const userService = require('../services/userService');
const sheetsService = require('../services/sheets');
const logger = require('../utils/logger');
const config = require('../config');

// Admin list
const ADMINS = [316425068];

/**
 * Check if a user is an admin
 * @param {Number} userId 
 * @returns {Boolean}
 */
function isAdmin(userId) {
    const ADMIN_ID = 316425068;
    return userId === ADMIN_ID || userId === parseInt(process.env.ADMIN_ID);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Get the appropriate main menu keyboard based on user role
 * @param {Object} ctx - Telegraf context
 */
async function getMainMenu(ctx) {
    const userId = ctx.from.id;
    const isUserAdmin = isAdmin(userId);

    // Fetch dynamic surveys for this bot
    let surveyButtons = [];
    try {
        const botToken = config.botToken;
        const bot = await prisma.bot.findUnique({
            where: { token: botToken },
            include: {
                surveys: {
                    where: { isActive: true }
                }
            }
        });

        if (bot && bot.surveys) {
            surveyButtons = bot.surveys.map(s => s.triggerButton);
        }
    } catch (err) {
        logger.error('Error fetching surveys for menu:', err);
    }

    // Default static fallback if no surveys exist
    if (surveyButtons.length === 0) {
        surveyButtons = ['📊 Опрос качества'];
    }

    // Standard buttons for regular users
    const userButtons = [
        ['🛠 Поддержка', ...surveyButtons.slice(0, 1)], // First row: Support + First Survey
        ['💳 Управление лимитом', '🚘 Мой автомобиль'],
        ['🚖 Yandex Taxi Fun', '🚗 Подключиться'],
        ['📖 Новости']
    ];

    // Add any remaining survey buttons to new rows (2 per row)
    const extraSurveys = surveyButtons.slice(1);
    for (let i = 0; i < extraSurveys.length; i += 2) {
        userButtons.push(extraSurveys.slice(i, i + 2));
    }

    // Push final row
    userButtons.push(['🔙 Меню']);

    let adminButtons = [];
    if (isUserAdmin) {
        adminButtons = [
            ['💼 CRM', '📈 Отчёты'],
            ['📝 Создать опрос', '👥 Пользователи'],
            ['📊 Аналитика', '⚙️ Настройки бота']
        ];
    }

    const keyboard = Markup.keyboard([
        ...userButtons,
        ...adminButtons
    ]).resize().oneTime(false);

    const buttonList = [
        ...userButtons.flat(),
        ...adminButtons.flat()
    ];

    logger.info(`[KEYBOARD] Generated for user ${userId} (Admin: ${isUserAdmin}): [${buttonList.join(', ')}]`);

    return keyboard;
}

/**
 * Show the main menu (reply keyboard) with robust state reset
 */
async function showMainMenu(ctx) {
    try {
        const userId = ctx.from.id;

        // ROBUST STATE RESET
        logger.info(`[FLOW RESET] ${userId} - Resetting flow and showing menu`);

        // 1. Leave any active Telegraf scene
        if (ctx.scene && typeof ctx.scene.leave === 'function') {
            await ctx.scene.leave().catch(e => logger.error('Scene leave error:', e));
        }

        // 2. Clear Wizard state
        if (ctx.wizard) {
            ctx.wizard.state = {};
        }

        // 3. Reset SQLite state via UserService
        await userService.resetUserFlow(userId).catch(e => logger.error('Database reset error:', e));

        const menu = await getMainMenu(ctx);

        await ctx.reply(
            '🏠 *Главное меню*\n\nВыберите интересующий раздел:',
            {
                ...menu,
                parse_mode: 'Markdown'
            }
        ).catch(e => {
            console.error('Error sending main menu:', e);
            // Fallback plain text reply
            ctx.reply('Выберите действие в меню.').catch(() => { });
        });
    } catch (err) {
        console.error('CRITICAL: Error in showMainMenu:', err);
    }
}

/**
 * Request phone number from user
 */
async function requestPhone(ctx) {
    await ctx.reply(
        '📱 Для начала опроса, пожалуйста, предоставьте ваш номер телефона.',
        Markup.keyboard([
            [Markup.button.contactRequest('📱 Поделиться номером')],
            ['🔙 Меню']
        ]).resize()
    );
}

/**
 * Handle new main menu button actions
 */
async function handleMenuAction(ctx, surveyHandler, adminHandler) {
    const text = ctx.message?.text;
    const userId = ctx.from.id;
    const username = ctx.from.username;

    logger.info(`Menu action: "${text}" from user: ${userId}`);

    // UNIVERSAL RESET
    if (text === '🔙 Меню') {
        return await showMainMenu(ctx);
    }

    // DYNAMIC SURVEY CHECK
    try {
        const botToken = config.botToken;
        const bot = await prisma.bot.findUnique({
            where: { token: botToken },
            include: { surveys: { where: { isActive: true } } }
        });

        if (bot && bot.surveys) {
            const matchedSurvey = bot.surveys.find(s => s.triggerButton === text);
            if (matchedSurvey) {
                if (surveyHandler && surveyHandler.handleStartSurvey) {
                    ctx.session.activeSurveyId = matchedSurvey.id;
                    return await surveyHandler.handleStartSurvey(ctx);
                }
                return await ctx.reply('Опрос временно недоступен.');
            }
        }
    } catch (err) {
        logger.error('Error checking dynamic surveys:', err);
    }

    // STATIC BUTTONS
    switch (text) {
        case '🛠 Поддержка':
            return await ctx.reply('🧑‍💻 *Техподдержка*\n\nНажмите кнопку ниже, чтобы написать в поддержку парка или задать вопрос.', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('Написать в поддержку', 'https://t.me/yokopark')]
                ])
            });

        case '📖 Новости':
            return await ctx.reply('📢 *Новости парка*\n\nАктуальные новости и советы для водителей публикуются в нашем канале.', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('Открыть канал новостей', 'https://t.me/yandex_taxi_fun')]
                ])
            });

        case '🚖 Yandex Taxi Fun':
            return await ctx.reply('🚖 *Yandex Taxi Fun*\n\nЖивой канал водителей: мемы, истории и общение с коллегами.', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('Перейти в канал', 'https://t.me/yandex_taxi_fun')]
                ])
            });

        case '🚗 Подключиться':
            const connectionHandler = require('./connection');
            return await connectionHandler.startConnectionFlow(ctx);

        case '💳 Управление лимитом':
            // Enter the limit management scene
            if (ctx.scene) {
                return await ctx.scene.enter('limit_management_scene');
            }
            return await ctx.reply('Управление лимитами временно недоступно.');

        case '📤 Отправить данные менеджеру':
            try {
                const user = await userService.getUserByTelegramId(userId);
                const phone = user?.phone;
                if (!phone) {
                    return await ctx.reply('Ваш телефон еще не сохранен. Пожалуйста, отправьте контакт через меню подключения или опрос.', {
                        ...Markup.keyboard([
                            [Markup.button.contactRequest('📱 Поделиться контактом')],
                            ['🔙 Меню']
                        ]).resize()
                    });
                }

                await ctx.reply('⏳ Отправляю данные...');

                // Call webhook
                const apiUrl = process.env.CRM_WEBHOOK_URL || 'http://localhost:3002/api/webhooks/bot';
                const payloadStr = JSON.stringify({
                    action: 'sync_user',
                    payload: { telegramId: userId, username: username, phone: phone }
                });

                const parsed = new URL(apiUrl);
                const httpLib = parsed.protocol === 'https:' ? require('https') : require('http');
                const req = httpLib.request({
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payloadStr),
                        'x-bot-signature': process.env.BOT_CRM_SECRET || 'secret'
                    }
                }, (res) => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        ctx.reply('✅ Данные успешно отправлены менеджеру!').catch(() => { });
                    } else {
                        ctx.reply('❌ Ошибка отправки данных. Попробуйте позже.').catch(() => { });
                    }
                });

                req.on('error', (err) => {
                    logger.error('Error sending data to CRM:', err);
                    ctx.reply('❌ Ошибка связи с CRM.').catch(() => { });
                });
                req.write(payloadStr);
                req.end();
            } catch (err) {
                logger.error('Error sending data to CRM:', err);
                await ctx.reply('❌ Ошибка связи с CRM.');
            }
            return;
    }

    // Admin/CRM Buttons logic
    if (isAdmin(userId)) {
        if (!adminHandler) {
            return await ctx.reply('Админ-модуль не загружен.');
        }

        switch (text) {
            case '📈 Отчёты':
                return await adminHandler.handleStats(ctx);
            case '👥 Пользователи':
                return await adminHandler.handleUsers(ctx);
            case '📊 Аналитика':
                return await adminHandler.handleActions(ctx);
            case '💼 CRM':
            case '📝 Создать опрос':
            case '⚙️ Настройки бота':
                return await ctx.reply(`Раздел "${text}" находится в разработке.`);
        }
    }

    // Default Fallback - only if it's not a known menu button or handled above
    if (text) {
        await ctx.reply('Неизвестная команда или кнопка. Пожалуйста, воспользуйтесь меню ниже или нажмите /start.');
    }
}

/**
 * Handle /start command
 */
async function handleStart(ctx) {
    try {
        const { from, startPayload } = ctx;
        logger.info('/start pressed by user:', from.id, 'payload:', startPayload);

        // Register user and log command
        await userService.registerUser(from);
        await userService.logAction(from.id, from.username, 'START_COMMAND', { payload: startPayload });

        // IMPORTANT: Ensure the bot exists in Prisma DB so surveys work
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();
        const botToken = config.botToken?.trim() || '';
        let botDb = null;
        try {
            if (botToken) {
                botDb = await prisma.bot.findFirst({
                    where: { token: botToken },
                    include: { surveys: true }
                });
                if (!botDb) {
                    logger.info(`Auto-creating bot in DB on /start with token ${botToken.substring(0, 8)}...`);
                    botDb = await prisma.bot.create({
                        data: {
                            token: botToken,
                            name: config.botName || 'Main Bot',
                            surveys: { create: {} }
                        }
                    });
                } else if (!botDb.surveys || botDb.surveys.length === 0) {
                    await prisma.survey.create({ data: { botId: botDb.id } });
                }
            }
        } catch (dbErr) {
            logger.error('Error auto-creating bot in DB:', dbErr.message);
        }

        // --- NEW: Track BOT_STARTED Analytics Event ---
        try {
            if (botDb) {
                // Find Prisma User to link event
                const prismaUser = await prisma.user.findFirst({
                    where: { botId: botDb.id, telegramId: from.id }
                });

                await prisma.analyticsEvent.create({
                    data: {
                        botId: botDb.id,
                        userId: prismaUser ? prismaUser.id : null,
                        eventType: 'BOT_STARTED'
                    }
                });
                logger.info(`[Analytics] Tracked BOT_STARTED for user ${from.id}`);
            }
        } catch (analyticsErr) {
            logger.error('Failed to log BOT_STARTED event:', analyticsErr.message);
        } finally {
            await prisma.$disconnect();
        }

        // Update Google Sheets with "Opened" status
        try {
            await sheetsService.upsertUserRow(from.id, from.username, { 'Status': 'Opened' });
        } catch (sErr) {
            logger.error('Failed to update sheets on start:', sErr.message);
        }

        // Show role-based main menu
        await showMainMenu(ctx);

    } catch (err) {
        logger.error('Error in start handler:', err);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

/**
 * Fallback message handler
 */
async function handleMessage(ctx, surveyHandler, adminHandler) {
    if (ctx.message?.text) {
        return handleMenuAction(ctx, surveyHandler, adminHandler);
    }

    // Default reply if unknown content
    await showMainMenu(ctx);
}

module.exports = {
    showMainMenu,
    handleStart,
    handleMenuAction,
    handleMessage,
    requestPhone
};
