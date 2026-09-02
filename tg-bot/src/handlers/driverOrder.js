/**
 * "🚖 Текущий заказ" scene.
 *
 * Entry: driver taps the menu button. Bot calls CRM /api/webhooks/bot action
 *   get_order_price → CRM proxies to yandex-fleet-scraper, returns taskId →
 *   bot polls poll_driver_action every 2s until status != PENDING (or timeout).
 *
 * Card shows: # short order id, from/to address, current price, duration,
 *   payment method. Three reply buttons:
 *     🔄 Обновить      — re-fetch
 *     ✅ Завершить заказ — two-step confirm → CRM action complete_order
 *     ❌ Отменить заказ  — two-step confirm → CRM action cancel_order
 *
 * Backend statuses we display:
 *   DONE                — happy path; show card / "Готово!"
 *   PENDING (timeout)   — "система не ответила, попробуйте позже"
 *   ESCALATED_TO_MANAGER — "✉️ Передал менеджеру"
 *   NEEDS_REASON_PROBE  — "✉️ Передал менеджеру" (cancel modal not yet probed)
 *   FAILED              — "❌ Ошибка: ..."
 *   NOT_LINKED          — "Привяжите профиль через Мой автомобиль"
 *   NO_YANDEX_ID        — "Передал менеджеру"
 *   SCRAPER_DOWN        — "Система недоступна, передал менеджеру"
 */
const { Scenes, Markup } = require('telegraf');
const https = require('https');
const http = require('http');
const logger = require('../utils/logger');
const { exactTelegramActionBinding } = require('../services/exactTelegramActionBinding');

// Same env resolution as carManagement.js — action calls must go to
// /api/webhooks/bot, NOT /api/webhook/telegram. CRM_WEBHOOK_URL is reserved
// for the per-message forwarder.
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
    logger.info(`[DriverOrder] CRM ${action}: status=${result.status} ok=${result.data?.ok}`);
    return result;
}

/**
 * Fire an action then poll for terminal status. Returns the final state
 * object (whatever CRM returned in the last poll), or an error envelope.
 */
async function actionAndPoll(ctx, action, extraPayload = {}) {
    const authorityPayload = {
        telegramId: String(ctx.from.id),
        ...exactTelegramActionBinding(ctx),
    };
    const initial = await callCRM(action, { ...extraPayload, ...authorityPayload });
    if (!initial.ok || initial.data?.ok === false) {
        return { ok: false, ...(initial.data || {}) };
    }
    let state = initial.data;
    if (!state.taskId) return { ok: true, ...state };

    const TIMEOUT_MS = 30000;
    const POLL_INTERVAL_MS = 2000;
    const started = Date.now();
    while (state.status === 'PENDING' && Date.now() - started < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await callCRM('poll_driver_action', {
            taskId: state.taskId,
            ...authorityPayload,
        });
        if (poll.ok && poll.data?.ok) {
            state = { ...state, ...poll.data };
        }
    }
    return { ok: true, ...state };
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

function orderKeyboard() {
    return Markup.keyboard([
        ['🔄 Обновить'],
        ['✅ Завершить заказ', '❌ Отменить заказ'],
        ['🔙 Меню']
    ]).resize();
}

function confirmKeyboard(label) {
    return Markup.keyboard([[`Да, ${label}`, 'Нет']]).resize().oneTime(true);
}

function renderOrderCard(state) {
    const r = state?.result || {};
    const lines = ['🚖 *Текущий заказ*'];
    if (r.shortOrderId && r.shortOrderId !== '0000000') lines.push(`📋 Номер: *${r.shortOrderId}*`);
    if (r.bookedAt) lines.push(`🗓 Дата подачи: ${r.bookedAt}`);
    if (r.orderSource) lines.push(`🏷 Чей заказ: ${r.orderSource}`);
    if (r.fromAddress && r.fromAddress !== 'мок') {
        lines.push(`📍 Откуда: ${r.fromAddress}`);
    }
    if (Array.isArray(r.stops) && r.stops.length > 0) {
        for (const stop of r.stops) {
            lines.push(`🔸 Промежуточная: ${stop}`);
        }
    }
    if (r.toAddress && r.toAddress !== 'мок' && r.toAddress.trim().length > 0) {
        lines.push(`🏁 Куда: ${r.toAddress}`);
    } else {
        lines.push(`🏁 Куда: _появится, когда нажмёте «На месте»_`);
    }
    if (typeof r.priceRub === 'number' && r.priceRub > 0) {
        const priceStr = Number.isInteger(r.priceRub)
            ? r.priceRub.toLocaleString('ru-RU')
            : r.priceRub.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        lines.push(`💵 Цена: *${priceStr} ₽*`);
    } else {
        lines.push(`💵 Цена: _появится, когда нажмёте «На месте»_`);
    }
    if (r.tariff) lines.push(`🚗 Тариф: ${r.tariff}`);
    if (r.paymentMethod) lines.push(`💳 Оплата: ${r.paymentMethod}`);
    if (r.parkName) lines.push(`ℹ️ Парк: ${r.parkName}`);
    if (r.mock) lines.push('_(временно — мок-данные)_');
    return lines.join('\n');
}

async function showOrderCard(ctx, state) {
    await ctx.reply(renderOrderCard(state), { parse_mode: 'Markdown', ...orderKeyboard() });
    // If scraper attached a route map screenshot, send it as a photo.
    const b64 = state?.result?.mapImageBase64;
    if (b64 && typeof b64 === 'string' && b64.length > 100) {
        try {
            const buf = Buffer.from(b64, 'base64');
            await ctx.replyWithPhoto({ source: buf }, { caption: '🗺 Маршрут' });
        } catch (e) {
            logger.warn(`[DriverOrder] map photo send failed: ${e?.message || e}`);
        }
    }
}

async function reportFailure(ctx, state) {
    // Map various failure shapes to a user-friendly message.
    if (state.error === 'NOT_LINKED') {
        await ctx.reply('⚠️ Профиль не привязан. Нажмите «🚘 Мой автомобиль» и поделитесь номером.');
        return;
    }
    if (state.error === 'NO_YANDEX_ID' || state.status === 'ESCALATED_TO_MANAGER') {
        await ctx.reply('✉️ Передал менеджеру — он свяжется с тобой.');
        return;
    }
    if (state.error === 'SCRAPER_DOWN' || state.status === 'FAILED' || state.status === 'TIMEOUT') {
        await ctx.reply(`❌ Не получилось: ${state.errorMessage || state.message || 'попробуйте позже'}`);
        return;
    }
    if (state.status === 'NEEDS_REASON_PROBE') {
        await ctx.reply('✉️ Передал менеджеру — он подтвердит отмену.');
        return;
    }
    await ctx.reply(state.message || '❌ Что-то пошло не так. Попробуйте позже.');
}

const driverOrderScene = new Scenes.WizardScene(
    'driverOrder',

    // ── Step 0: enter — fetch the price card ──────────────────────────
    async (ctx) => {
        await ctx.reply('⏳ Запрашиваю текущий заказ…', Markup.removeKeyboard());
        const state = await actionAndPoll(ctx, 'get_order_price');
        if (!state.ok || (state.status && state.status !== 'DONE')) {
            await reportFailure(ctx, state);
            return goToMainMenu(ctx);
        }
        if (state.result?.noActiveOrder) {
            await ctx.reply('🚫 Сейчас у вас нет активного заказа.\n\nКогда вы будете везти клиента — здесь появится карточка с действиями.');
            return goToMainMenu(ctx);
        }
        await showOrderCard(ctx, state);
        return ctx.wizard.next();
    },

    // ── Step 1: handle reply-keyboard buttons ─────────────────────────
    async (ctx) => {
        const text = ctx.message?.text;
        if (!text) return;
        if (text === '🔙 Меню' || text === 'Отмена') return goToMainMenu(ctx);

        if (text === '🔄 Обновить') {
            await ctx.reply('⏳ Обновляю…');
            const state = await actionAndPoll(ctx, 'get_order_price');
            if (!state.ok || state.status !== 'DONE') { await reportFailure(ctx, state); return goToMainMenu(ctx); }
            if (state.result?.noActiveOrder) {
                await ctx.reply('🚫 Заказ уже завершён или отменён.');
                return goToMainMenu(ctx);
            }
            await showOrderCard(ctx, state);
            return; // stay on this step
        }
        if (text === '✅ Завершить заказ') {
            ctx.wizard.state.pendingAction = 'complete_order';
            ctx.wizard.state.pendingLabel = 'завершить';
            await ctx.reply('Точно *завершить* заказ?', { parse_mode: 'Markdown', ...confirmKeyboard('завершить') });
            return ctx.wizard.next();
        }
        if (text === '❌ Отменить заказ') {
            ctx.wizard.state.pendingAction = 'cancel_order';
            ctx.wizard.state.pendingLabel = 'отменить';
            await ctx.reply('Точно *отменить* заказ?', { parse_mode: 'Markdown', ...confirmKeyboard('отменить') });
            return ctx.wizard.next();
        }
        await ctx.reply('Нажмите кнопку под клавиатурой.', orderKeyboard());
    },

    // ── Step 2: confirm complete / cancel ─────────────────────────────
    async (ctx) => {
        const text = ctx.message?.text;
        if (!text || text === 'Нет' || text === '🔙 Меню') return goToMainMenu(ctx);
        if (!text.startsWith('Да')) {
            await ctx.reply('Ответьте «Да» или «Нет».');
            return;
        }
        const action = ctx.wizard.state.pendingAction;
        if (!action) return goToMainMenu(ctx);

        await ctx.reply('⏳ Передаю в систему…', Markup.removeKeyboard());
        const state = await actionAndPoll(ctx, action);

        if (state.status === 'DONE' && state.result?.noActiveOrder) {
            await ctx.reply('🚫 Заказа уже нет — наверное, его только что закрыли.');
        } else if (state.status === 'DONE' && state.result?.screenshotProbe) {
            // Screenshot-probe mode: send the modal screenshot for debugging
            await ctx.reply('📸 Скриншот модалки отмены — смотри что появилось:');
            const b64 = state.result?.modalImageBase64;
            if (b64 && b64.length > 100) {
                try {
                    await ctx.replyWithPhoto({ source: Buffer.from(b64, 'base64') }, { caption: 'Модалка после нажатия «Отменить»' });
                } catch (e) {
                    logger.warn(`[DriverOrder] modal screenshot send failed: ${e?.message || e}`);
                    await ctx.reply('(скриншот не удалось отправить)');
                }
            }
        } else if (state.status === 'DONE') {
            const verb = action === 'complete_order' ? 'завершён' : 'отменён';
            await ctx.reply(`✅ Заказ ${verb}.`);
            // Send modal screenshot if scraper captured one
            const b64 = state.result?.modalImageBase64;
            if (b64 && b64.length > 100) {
                try {
                    await ctx.replyWithPhoto({ source: Buffer.from(b64, 'base64') }, { caption: '📸 Скриншот из системы' });
                } catch (e) {
                    logger.warn(`[DriverOrder] modal screenshot send failed: ${e?.message || e}`);
                }
            }
        } else {
            await reportFailure(ctx, state);
        }
        return goToMainMenu(ctx);
    }
);

module.exports = driverOrderScene;
