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

function postJSON(url, body) {
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
                'x-bot-signature': CRM_SECRET()
            }
        };
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(body) });
                } catch {
                    resolve({ ok: false, data: {} });
                }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, data: { error: 'timeout' } }); });
        req.on('error', () => resolve({ ok: false, data: {} }));
        req.write(data);
        req.end();
    });
}

const parkSelectScene = new Scenes.WizardScene('parkSelect',

    // Step 0: show either verified onboarding candidates or the configured park list
    async (ctx) => {
        const sceneState = ctx.scene.state || {};
        const onboarding = sceneState.onboarding === true;
        let parks = Array.isArray(sceneState.parks) ? sceneState.parks : [];

        if (!onboarding) {
            const result = await postJSON(CRM_URL(), { action: 'list_parks', payload: {} });
            parks = result.data?.parks || [];
            if (!result.ok) parks = [];
        }

        if (!parks.length) {
            await ctx.reply('❌ Не удалось загрузить список парков. Попробуйте позже.');
            const startHandler = require('./start');
            await startHandler.showMainMenu(ctx);
            return ctx.scene.leave();
        }

        ctx.wizard.state.parks = parks;
        ctx.wizard.state.onboarding = onboarding;
        ctx.wizard.state.phone = sceneState.phone;
        ctx.wizard.state.username = sceneState.username;

        const buttons = parks.map(p => [p.name]);
        buttons.push(['🔙 Меню']);

        await ctx.reply(
            onboarding
                ? '🏢 *Ваш номер найден в нескольких парках*\n\nВыберите парк, в котором вы сейчас работаете.'
                : '🏢 *Выберите активный парк*\n\nИнформация о заказе будет показываться из выбранного парка.',
            {
                parse_mode: 'Markdown',
                ...Markup.keyboard(buttons).resize()
            }
        );
        return ctx.wizard.next();
    },

    // Step 1: handle selection
    async (ctx) => {
        const text = ctx.message?.text;
        const startHandler = require('./start');

        if (!text || text === '🔙 Меню') {
            await startHandler.showMainMenu(ctx);
            return ctx.scene.leave();
        }

        const parks = ctx.wizard.state.parks || [];
        const selected = parks.find(p => p.name === text);

        if (!selected) {
            await ctx.reply('Нажмите кнопку с названием парка.');
            return;
        }

        const telegramId = String(ctx.from.id);
        const onboarding = ctx.wizard.state.onboarding === true;
        const request = onboarding
            ? {
                action: 'sync_user',
                payload: {
                    telegramId,
                    username: ctx.wizard.state.username,
                    phone: ctx.wizard.state.phone,
                    parkId: selected.parkId
                }
            }
            : {
                action: 'set_active_park',
                payload: { telegramId, parkId: selected.parkId }
            };
        const { ok, data } = await postJSON(CRM_URL(), request);

        if (data?.error === 'NOT_IN_PARK') {
            await ctx.reply(
                `❌ У вас нет профиля в парке *${data.parkName || selected.name}*.\n\nВыберите другой парк или обратитесь к менеджеру.`,
                { parse_mode: 'Markdown' }
            );
            // Stay in scene so driver can pick another park
            return;
        }

        if (data?.error === 'PARK_CHECK_UNAVAILABLE' || data?.error === 'PARK_LOOKUP_UNAVAILABLE' || data?.error === 'timeout') {
            await ctx.reply(
                onboarding
                    ? '🔌 Яндекс Флит временно не ответил. Парк не назначен — попробуйте выбрать его ещё раз.'
                    : '🔌 Яндекс Флит временно не ответил. Парк не изменён — попробуйте выбрать его ещё раз.'
            );
            return;
        }

        if (data?.error === 'PARK_PROFILE_AMBIGUOUS') {
            await ctx.reply(
                onboarding
                    ? '⚠️ В этом парке найдено несколько профилей с вашим номером. Парк не назначен — обратитесь к менеджеру.'
                    : '⚠️ В этом парке найдено несколько профилей с вашим номером. Парк не изменён — обратитесь к менеджеру.'
            );
            return;
        }

        if (!ok) {
            await ctx.reply(data?.message || '❌ Не удалось сохранить выбор. Попробуйте позже.');
            return;
        }

        if (onboarding && data.autoLinked) {
            await ctx.reply(
                `✅ *Профиль найден и привязан!*\n\nВодитель: *${data.driverName}*\nПарк: *${data.parkName || selected.name}*`,
                { parse_mode: 'Markdown' }
            );
            logger.info(`[ParkSelect] TG ${telegramId} linked → park ${selected.parkId}`);
        } else if (onboarding) {
            await ctx.reply(
                '📨 *Запрос отправлен менеджеру*\n\nВ выбранном парке найдено несколько профилей с вашим номером. Менеджер проверит и привяжет нужный.',
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.reply(`✅ Активный парк: *${data.parkName || selected.name}*`, { parse_mode: 'Markdown' });
            logger.info(`[ParkSelect] TG ${telegramId} → park ${selected.parkId}`);
        }

        await startHandler.showMainMenu(ctx);
        return ctx.scene.leave();
    }
);

module.exports = parkSelectScene;
