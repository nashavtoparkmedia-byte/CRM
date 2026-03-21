const { Scenes, Markup } = require('telegraf');
const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

const CRM_URL = () => process.env.CRM_WEBHOOK_URL || 'http://localhost:3002/api/webhooks/bot';
const CRM_SECRET = () => process.env.BOT_CRM_SECRET || 'secret';

function postJSON(url, body, headers = {}) {
    return new Promise((resolve) => {
        const parsed = new URL(url);
        const data = JSON.stringify(body);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...headers
            }
        };
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ ok: false, status: res.statusCode, data: { error: body } });
                }
            });
        });
        req.on('error', (err) => resolve({ ok: false, status: 0, data: { error: err.message } }));
        req.write(data);
        req.end();
    });
}

async function callCRM(action, payload) {
    logger.info(`[LimitScene] Calling CRM action=${action} url=${CRM_URL()}`);
    const result = await postJSON(CRM_URL(), { action, payload }, {
        'x-bot-signature': CRM_SECRET()
    });
    logger.info(`[LimitScene] CRM response: status=${result.status}`);
    return result;
}

async function goToMainMenu(ctx) {
    try {
        const startHandler = require('./start');
        if (startHandler.showMainMenu) {
            await startHandler.showMainMenu(ctx);
        } else {
            await ctx.reply('🏠 Главное меню', Markup.removeKeyboard());
        }
    } catch (e) {
        await ctx.reply('🏠 Главное меню', Markup.removeKeyboard());
    }
    return ctx.scene.leave();
}

const limitManagementScene = new Scenes.WizardScene(
    'limit_management_scene',

    // Step 0: Try CRM check_link
    async (ctx) => {
        await ctx.reply('⏳ Проверяю ваш профиль...', Markup.removeKeyboard());

        const result = await callCRM('check_link', { telegramId: String(ctx.from.id) });

        // CRM unreachable
        if (result.status === 0 || result.status === 504) {
            await ctx.reply(
                `🔌 *Не удалось подключиться к CRM*\n\n` +
                `Управление лимитом сейчас недоступно.\n` +
                `Попробуйте позже. Если проблема сохраняется — перейдите в *🚘 Мой автомобиль* для привязки профиля.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([['🔙 Меню']]).resize()
                }
            );
            return goToMainMenu(ctx);
        }

        // Not linked
        if (!result.ok || !result.data.linked) {
            await ctx.reply(
                `🔗 *Профиль не привязан*\n\n` +
                `Ваш Telegram ещё не связан с профилем водителя.\n\n` +
                `→ Перейдите в *🚘 Мой автомобиль* — там можно привязать профиль через номер телефона.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([['🔙 Меню']]).resize()
                }
            );
            return goToMainMenu(ctx);
        }

        // Linked — show limit input
        const data = result.data;
        ctx.wizard.state.mode = 'enter_limit';
        ctx.wizard.state.driverName = data.driverName;
        const carLine = data.carInfo ? `🚗 Автомобиль: *${data.carInfo}*\n` : '';
        await ctx.reply(
            `💳 *Управление лимитом*\n\n` +
            `👤 *${data.driverName || 'Ваш профиль'}*\n` +
            `${carLine}\n` +
            `📋 *Правила ввода:*\n` +
            `• Только число (целое или с точкой)\n` +
            `• Минимум: *1 ₽*\n` +
            `• Пример: \`500\` или \`1500.50\`\n\n` +
            `Введите желаемую сумму лимита:`,
            {
                parse_mode: 'Markdown',
                ...Markup.keyboard([['Отмена']]).resize()
            }
        );

        return ctx.wizard.next();
    },

    // Step 1: Handle limit input
    async (ctx) => {
        const text = ctx.message?.text;

        if (text === 'Отмена' || text === '🔙 Меню') {
            return goToMainMenu(ctx);
        }

        const sanitized = (text || '').replace(/\s/g, '');
        const limitValue = parseFloat(sanitized);

        if (isNaN(limitValue) || limitValue < 1) {
            await ctx.reply('⚠️ Введите корректное положительное число (больше 0). Например: 5000');
            return;
        }

        await ctx.reply('⏳ Отправляю запрос на изменение лимита...');

        const result = await callCRM('change_limit', {
            telegramId: String(ctx.from.id),
            limitValue: limitValue
        });

        if (result.status === 0 || result.status === 504) {
            await ctx.reply('🔌 CRM недоступна. Попробуйте позже.');
        } else if (result.ok && result.data.success) {
            await ctx.reply(`✅ Лимит успешно изменён!\nНовое значение: *${limitValue} ₽*`, { parse_mode: 'Markdown' });
        } else if (result.status === 404 && result.data.error === 'NOT_LINKED') {
            await ctx.reply('❌ Профиль не найден. Перейдите в *🚘 Мой автомобиль* для привязки.', { parse_mode: 'Markdown' });
        } else if (result.status === 502) {
            const yandexErr = result.data?.yandexError ? JSON.stringify(result.data.yandexError).substring(0, 200) : result.data?.error || 'Неизвестная ошибка';
            await ctx.reply(`❌ Ошибка Яндекс API:\n${yandexErr}`);
        } else {
            await ctx.reply(`❌ Ошибка: ${result.data?.error || 'Неизвестная ошибка'}`);
        }

        return goToMainMenu(ctx);
    }
);

module.exports = limitManagementScene;
