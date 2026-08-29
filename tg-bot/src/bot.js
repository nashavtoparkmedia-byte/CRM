require('./utils/log-interceptor');
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const config = require('./config');
const db = require('./database');
const logger = require('./utils/logger');
const { ensureBotMappingV1 } = require('./public-bot-maintenance');
const sheetsService = require('./services/sheets');
const botRegistrySync = require('./services/botRegistrySync');

// Import handlers
const startHandler = require('./handlers/start');
const surveyHandler = require('./handlers/dynamicSurvey');
const adminHandler = require('./handlers/admin');
const crmIntegration = require('./services/crmIntegration');
const limitManagementScene = require('./handlers/balanceLimit');
const carManagementScene = require('./handlers/carManagement');
const driverOrderScene = require('./handlers/driverOrder');
const quickLimitScene = require('./handlers/quickLimit');
const parkSelectScene = require('./handlers/parkSelect');

// Validate configuration
config.validate();

// SOCKS5 proxy for Telegram API (РКН block bypass).
// Read TELEGRAM_SOCKS_PROXY from .env, default to local xray on 10808.
// Setting it to empty string disables the proxy.
const telegrafOptions = {};
const socksUrl = process.env.TELEGRAM_SOCKS_PROXY ?? 'socks5://127.0.0.1:10808';
if (socksUrl) {
    try {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const agent = new SocksProxyAgent(socksUrl);
        telegrafOptions.telegram = { agent };
        logger.info('Telegram API via configured SOCKS proxy');
    } catch (e) {
        logger.error(`Failed to init configured SOCKS proxy: ${e.message}`);
    }
}

// Create bot instance
const bot = new Telegraf(config.botToken, telegrafOptions);

// 1. Session middleware (Must be first)
bot.use(session());

// =============================================================================
// INTERRUPTION MIDDLEWARE
// =============================================================================

// This middleware intercepts main menu buttons BEFORE Stage, 
// ensuring they reset any active scene/wizard on the FIRST click.
const staticButtons = [
    '🔙 Меню',
    '🛠 Поддержка',
    '📖 Новости',
    '🚖 Yandex Taxi Fun',
    '🚗 Подключиться',
    '🚘 Мой автомобиль',
    '🚖 Текущий заказ',
    '💳 Только безнал',
    '💵 Включить наличку'
];

bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text) {
        let isInterrupt = false;

        // Park button has dynamic label "🏢 ParkName" — match by prefix
        if (text.startsWith('🏢')) {
            isInterrupt = true;
        } else if (staticButtons.includes(text)) {
            isInterrupt = true;
        } else {
            // Check if text matches any active survey trigger
            try {
                const { PrismaClient } = require('@prisma/client');
                const prisma = new PrismaClient();
                const activeSurveys = await prisma.survey.findMany({
                    where: { isActive: true },
                    select: { triggerButton: true }
                });
                await prisma.$disconnect();

                if (activeSurveys.some(s => s.triggerButton === text)) {
                    isInterrupt = true;
                }
            } catch (err) {
                logger.error('Error fetching surveys for interruption:', err);
            }
        }

        if (isInterrupt) {
            console.log(`[SCENE INTERRUPT] ${text} from ${ctx.from?.id}`);
            if (ctx.session) {
                ctx.session.__scenes = {};
            }
            // CRITICAL FIX: Also reset SQLite state to IDLE so CONNECTION_MODE doesn't swallow the button routing
            try {
                const userService = require('./services/userService');
                await userService.setUserState(ctx.from.id, 'IDLE');
            } catch (err) {
                console.error('Error resetting state on interrupt:', err);
            }
        }
    }

    // FORWARD EVERYTHING TO CRM WEBHOOK (Unless it's an inline callback, which we handle next)
    try {
        crmIntegration.forwardMessageToCrm(ctx, 'INCOMING').catch(e => {
            console.error('Failed to pre-forward to CRM:', e);
        });
    } catch (e) {
        console.error('Failed to pre-forward to CRM:', e);
    }

    return next();
});

// 2. Stage initialization
const stage = new Scenes.Stage([surveyHandler.dynamicSurveyScene, limitManagementScene, carManagementScene, driverOrderScene, quickLimitScene, parkSelectScene]);

// 2.1 Universal Commands within Stage
stage.start(startHandler.handleStart);

// 3. Register Stage middleware (Adds ctx.scene and ctx.wizard)
bot.use(stage.middleware());

// =============================================================================
// GLOBAL HANDLERS (After Stage)
// =============================================================================

// 4. Command handlers
bot.start(startHandler.handleStart);
bot.command('start', startHandler.handleStart);
bot.command('admin', adminHandler.handleAdmin);
bot.command('stats', adminHandler.handleStats);
bot.command('users', adminHandler.handleUsers);
bot.command('actions', adminHandler.handleActions);
bot.command('broadcast', adminHandler.handleBroadcast);

// 5. Button handlers (explicit hears)

bot.hears('🔙 Меню', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🔙 Меню ${userId}`);
    return await startHandler.showMainMenu(ctx);
});

bot.hears('🚖 Yandex Taxi Fun', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🚖 Yandex Taxi Fun ${userId}`);
    return await ctx.reply('🚖 *Yandex Taxi Fun*\n\nЖивой канал водителей: мемы, истории и общение с коллегами.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('🚖 Открыть канал', 'https://t.me/yandex_taxi_fun')]
        ])
    });
});

bot.hears('📖 Новости', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 📖 Новости ${userId}`);
    return await ctx.reply('📢 *Новости парка*\n\nАктуальные новости и советы для водителей публикуются в нашем канале.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('Открыть канал новостей', 'https://t.me/yandex_taxi_fun')]
        ])
    });
});

bot.hears('🛠 Поддержка', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🛠 Поддержка ${userId}`);
    return await ctx.reply('🧑‍💻 *Техподдержка*\n\nНажмите кнопку ниже, чтобы написать в поддержку парка или задать вопрос.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('Написать в поддержку', 'https://t.me/yokopark')]
        ])
    });
});

bot.hears('🚗 Подключиться', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🚗 Подключиться ${userId}`);
    const connectionHandler = require('./handlers/connection');
    return await connectionHandler.startConnectionFlow(ctx);
});

bot.hears('🚘 Мой автомобиль', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🚘 Мой автомобиль ${userId}`);
    return await ctx.scene.enter('car_management_scene');
});

bot.hears('🚖 Текущий заказ', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🚖 Текущий заказ ${userId}`);
    return await ctx.scene.enter('driverOrder');
});

bot.hears(/^🏢/, async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 🏢 Park select ${userId}`);
    return await ctx.scene.enter('parkSelect');
});

// Quick limit presets (one tap each)
bot.hears('💳 Только безнал', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 💳 Только безнал ${userId}`);
    return await ctx.scene.enter('quick_limit', { targetLimit: 200000, label: '💳 Только безнал (лимит 200 000 ₽)' });
});

bot.hears('💵 Включить наличку', async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[BUTTON CLICK] 💵 Включить наличку ${userId}`);
    return await ctx.scene.enter('quick_limit', { targetLimit: 5, label: '💵 Включить наличку (лимит 5 ₽)' });
});

// Handle contact (phone number) sharing
bot.on('contact', async (ctx, next) => {
    try {
        const contact = ctx.message.contact;
        if (contact.user_id !== ctx.from.id) {
            return await ctx.reply('Пожалуйста, поделитесь своим собственным номером телефона.');
        }

        const userId = ctx.from.id;
        const phone = contact.phone_number;
        const username = ctx.from.username;
        const userService = require('./services/userService');
        const state = await userService.getUserState(userId);

        await userService.updateUser(userId, { phone, phone_verified: 1 });

        // If user is in an active wizard scene — pass contact there
        const activeScene = ctx.session?.__scenes?.current;
        if (activeScene === 'car_management_scene' || activeScene === 'limit_management_scene') {
            return next();
        }

        if (state === 'CONNECTION_MODE') {
            const connectionHandler = require('./handlers/connection');
            return await connectionHandler.handleConnectionData(ctx);
        }

        logger.info(`Received phone ${phone} from user ${userId} (Standard Flow)`);

        // Standard flow (Survey)
        const sheetsService = require('./services/sheets');
        await sheetsService.upsertUserRow(userId, username, {
            'Phone': phone,
            'Status': 'Started Survey'
        });

        await ctx.reply('✅ Номер подтверждён. Переходим к опросу.');
        return await surveyHandler.handleStartSurvey(ctx);
    } catch (err) {
        logger.error('Error in contact handler:', err);
        await ctx.reply('Произошла ошибка при сохранении номера.');
    }
});

// Middleware to catch connection mode data (Photos and Text)
bot.on(['message', 'photo'], async (ctx, next) => {
    try {
        if (ctx.message?.text === '🔙 Меню') return next();

        const userId = ctx.from.id;
        const userService = require('./services/userService');
        const state = await userService.getUserState(userId);

        if (state === 'CONNECTION_MODE') {
            const connectionHandler = require('./handlers/connection');
            return await connectionHandler.handleConnectionData(ctx);
        }

        return next();
    } catch (err) {
        logger.error('Error in connection mode middleware:', err);
        return next();
    }
});

// Global Callback Query handler
bot.on('callback_query', async (ctx) => {
    const userId = ctx.from.id;
    const data = ctx.callbackQuery.data;
    console.log(`[CALLBACK CLICK] ${data} from user ${userId}`);

    try {
        await ctx.answerCbQuery().catch(() => { });
    } catch (err) {
        // Ignore answer errors
    }
});

// 6. Fallback handler (LAST)
bot.on('message', async (ctx) => {
    try {
        return await startHandler.handleMessage(ctx, surveyHandler, adminHandler);
    } catch (err) {
        logger.error('Error in final fallback:', err);
        return await startHandler.showMainMenu(ctx);
    }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED REJECTION at:', promise, 'Reason:', reason);
});

// =============================================================================
// START BOT
// =============================================================================

// Initialize DB Bot mapping
async function initializeBotInDb() {
    try {
        const botToken = config.botToken?.trim() || '';
        if (botToken) {
            await ensureBotMappingV1({ token: botToken, name: config.botName || 'Main Bot' });
        }
    } catch (err) {
        logger.error('Error auto-creating bot in DB:', err.message);
    } finally {
    }
}

// Catch handler errors so a single broken update doesn't kill the polling loop.
bot.catch((err, ctx) => {
    logger.error(`[bot.catch] update=${ctx?.update?.update_id}: ${err?.message || err}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat watchdog
//
// Telegraf long-poll over SOCKS5 sometimes silently dies after a long idle
// period (the proxy connection drops but getUpdates keeps waiting). The bot
// looks alive (process is up, port 3001 listens) but new Telegram updates
// never arrive. We probe with getMe every N minutes — if it fails or times
// out, we stop the bot and relaunch polling. Same process, no Windows service.
// ─────────────────────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.BOT_HEARTBEAT_INTERVAL_MS || '300000', 10); // 5 min
const HEALTHCHECK_TIMEOUT_MS = 30000;
let lastActivityAt = Date.now();
let relaunching = false;

bot.use(async (ctx, next) => {
    lastActivityAt = Date.now();
    return next();
});

async function isPollingHealthy() {
    try {
        await Promise.race([
            bot.telegram.getMe(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('healthcheck timeout')), HEALTHCHECK_TIMEOUT_MS))
        ]);
        return true;
    } catch (e) {
        logger.warn(`[Heartbeat] getMe failed: ${e?.message || e}`);
        return false;
    }
}

async function relaunchPolling(reason) {
    if (relaunching) return;
    relaunching = true;
    logger.warn(`[Heartbeat] relaunch (reason: ${reason})`);
    try {
        bot.stop('heartbeat_relaunch');
    } catch (e) {
        logger.warn(`[Heartbeat] bot.stop threw: ${e?.message || e}`);
    }
    // Give Telegram a moment to release the previous getUpdates lock,
    // otherwise the new launch will get 409 Conflict.
    await new Promise(r => setTimeout(r, 3000));
    bot.launch()
        .then(() => logger.info('[Heartbeat] relaunched OK'))
        .catch((err) => logger.error(`[Heartbeat] relaunch failed: ${err?.message || err}`));
    // bot.launch() in polling mode never resolves; release the lock
    // immediately so future heartbeats can fire again.
    relaunching = false;
}

// Start sequence
Promise.all([
    sheetsService.initializeSheet().then(() => logger.info('Google Sheets initialization completed')),
    initializeBotInDb().then(() => logger.info('Database bot mapping verified')),
    botRegistrySync.syncPendingUsers()
]).then(() => {
    // bot.launch() returns a Promise that never resolves in polling mode —
    // we intentionally don't .then() it. We just need it kicked off.
    bot.launch().catch((err) => logger.error(`Bot launch error: ${err?.message || err}`));
    logger.info('Bot launching, heartbeat armed every ' + (HEARTBEAT_INTERVAL_MS / 1000) + 's');
    botRegistrySync.startPeriodicSync();

    setInterval(async () => {
        const idleSec = Math.floor((Date.now() - lastActivityAt) / 1000);
        logger.info(`[Heartbeat] tick — idle ${idleSec}s, last activity ${new Date(lastActivityAt).toISOString()}`);
        if (!await isPollingHealthy()) {
            await relaunchPolling('getMe failed');
        }
    }, HEARTBEAT_INTERVAL_MS);
}).catch((err) => {
    logger.error('Startup error:', err);
});

// Graceful shutdown
process.once('SIGINT', () => {
    logger.info('SIGINT received, stopping bot...');
    bot.stop('SIGINT');
    db.close().then(() => process.exit(0));
});

process.once('SIGTERM', () => {
    logger.info('SIGTERM received, stopping bot...');
    bot.stop('SIGTERM');
    db.close().then(() => process.exit(0));
});

module.exports = bot;
