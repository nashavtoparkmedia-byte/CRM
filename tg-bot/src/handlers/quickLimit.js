/**
 * Quick-limit scene — 1-click presets for "только безнал" / "включить наличку".
 *
 * Entry: bot.hears('💳 Только безнал' / '💵 Включить наличку') →
 *        ctx.scene.enter('quick_limit', { targetLimit, label })
 *
 * Step 0 — confirm: "Точно установить <label>? [Да] [Нет]".
 * Step 1 — on Да: POST CRM action='change_limit' { telegramId, limitValue }
 *          and report success or Yandex error.
 *
 * Uses the same per-action CRM URL resolution as carManagement.js:
 * BOT_ACTIONS_URL > origin(CRM_WEBHOOK_URL)/api/webhooks/bot > localhost.
 */
const { Scenes, Markup } = require('telegraf');
const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

const CRM_URL = () => {
    if (process.env.BOT_ACTIONS_URL) return process.env.BOT_ACTIONS_URL;
    const fwd = process.env.CRM_WEBHOOK_URL;
    if (fwd) {
        try {
            const u = new URL(fwd);
            return `${u.protocol}//${u.host}/api/webhooks/bot`;
        } catch { /* fall through */ }
    }
    return 'http://localhost:3002/api/webhooks/bot';
};
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
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, status: 504, data: { error: 'timeout' } }); });
        req.on('error', (err) => resolve({ ok: false, status: 0, data: { error: err.message } }));
        req.write(data);
        req.end();
    });
}

async function callCRM(action, payload) {
    const result = await postJSON(CRM_URL(), { action, payload }, { 'x-bot-signature': CRM_SECRET() });
    logger.info(`[QuickLimit] CRM ${action}: status=${result.status} ok=${result.data?.ok}`);
    return result;
}

async function goToMainMenu(ctx) {
    try {
        const startHandler = require('./start');
        if (startHandler.showMainMenu) await startHandler.showMainMenu(ctx);
        else await ctx.reply('🏠 Главное меню', Markup.removeKeyboard());
    } catch {
        await ctx.reply('🏠 Главное меню', Markup.removeKeyboard());
    }
    return ctx.scene.leave();
}

const quickLimitScene = new Scenes.WizardScene(
    'quick_limit',

    // Single step — execute immediately, no confirm.
    async (ctx) => {
        const targetLimit = ctx.scene.state?.targetLimit;
        const label = ctx.scene.state?.label || `${targetLimit} ₽`;
        if (typeof targetLimit !== 'number') {
            await ctx.reply('Не удалось распознать пресет лимита.');
            return goToMainMenu(ctx);
        }

        await ctx.reply('⏳ Меняю режим оплаты…', Markup.removeKeyboard());
        const result = await callCRM('change_limit', {
            telegramId: String(ctx.from.id),
            limitValue: targetLimit
        });

        if (result.status === 0 || result.status === 504) {
            await ctx.reply('🔌 Система временно недоступна. Попробуйте позже.');
        } else if (result.ok && result.data.success) {
            await ctx.reply(`✅ Готово`);
        } else if (result.status === 404 || result.data?.error === 'NOT_LINKED') {
            await ctx.reply('⚠️ Профиль не привязан. Нажмите *🚘 Мой автомобиль*.', { parse_mode: 'Markdown' });
        } else if (result.status === 502) {
            const yandexErr = result.data?.yandexError
                ? JSON.stringify(result.data.yandexError).substring(0, 200)
                : result.data?.error || 'ошибка';
            await ctx.reply(`❌ Ошибка Яндекс API:\n${yandexErr}`);
        } else {
            await ctx.reply(`❌ Ошибка: ${result.data?.error || 'неизвестная'}`);
        }
        return goToMainMenu(ctx);
    }
);

module.exports = quickLimitScene;
