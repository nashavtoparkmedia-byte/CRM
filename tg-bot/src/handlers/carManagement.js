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
        req.setTimeout(15000, () => {
            req.destroy();
            resolve({ ok: false, status: 504, data: { error: 'timeout' } });
        });
        req.on('error', (err) => resolve({ ok: false, status: 0, data: { error: err.message } }));
        req.write(data);
        req.end();
    });
}

async function callCRM(action, payload) {
    const result = await postJSON(CRM_URL(), { action, payload }, { 'x-bot-signature': CRM_SECRET() });
    logger.info(`[CarScene] CRM ${action}: status=${result.status}`);
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

async function showSearchPrompt(ctx) {
    await ctx.reply(
        `🔍 *Поиск автомобиля в базе*\n\nВведите первые символы госномера для поиска:\n_Например: Х111ХХ или Е352КО_`,
        {
            parse_mode: 'Markdown',
            ...Markup.keyboard([['🔙 Отмена']]).resize()
        }
    );
}

const carManagementScene = new Scenes.WizardScene(
    'car_management_scene',

    // ─── Step 0: Try CRM check_link ──────────────────────────────────────────
    async (ctx) => {
        await ctx.reply('⏳ Проверяю ваш профиль...', Markup.removeKeyboard());

        const result = await callCRM('check_link', { telegramId: String(ctx.from.id) });

        // CRM unreachable (status 0 = connection refused, 504 = timeout)
        if (result.status === 0 || result.status === 504) {
            // CRM down — still offer phone linking, don't just say "wait"
            ctx.wizard.state.mode = 'not_linked';
            await ctx.reply(
                `🔗 *Привязка профиля водителя*\n\n` +
                `Не удалось связаться с CRM, но мы можем попробовать привязать ваш профиль по номеру телефона.\n\n` +
                `Нажмите кнопку ниже:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([
                        [Markup.button.contactRequest('📱 Поделиться номером для привязки')],
                        ['🔙 Меню']
                    ]).resize()
                }
            );
            return ctx.wizard.next();
        }

        // CRM responded but profile not linked
        if (!result.ok || !result.data.linked) {
            ctx.wizard.state.mode = 'not_linked';
            await ctx.reply(
                `🔗 *Привязка профиля водителя*\n\n` +
                `Ваш Telegram ещё не связан с профилем водителя.\n\n` +
                `Нажмите кнопку ниже — мы найдём ваш профиль по номеру телефона и привяжем его.\n\n` +
                `После привязки придёт уведомление ✅`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([
                        [Markup.button.contactRequest('📱 Поделиться номером для привязки')],
                        ['🔙 Меню']
                    ]).resize()
                }
            );
            return ctx.wizard.next();
        }

        // All good — profile linked
        const data = result.data;
        ctx.wizard.state.mode = 'linked';
        ctx.wizard.state.driverName = data.driverName;
        ctx.wizard.state.carInfo = data.carInfo || null;

        if (data.carInfo) {
            await ctx.reply(
                `🚘 *Мой автомобиль*\n\n` +
                `👤 Водитель: *${data.driverName || 'Ваш профиль'}*\n\n` +
                `🚗 *${data.carInfo}*\n\n` +
                `Хотите сменить автомобиль?`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.keyboard([['🔄 Сменить автомобиль'], ['🔙 Меню']]).resize()
                }
            );
        } else {
            await ctx.reply(
                `🚘 *Мой автомобиль*\n\n` +
                `👤 Водитель: *${data.driverName || 'Ваш профиль'}*\n` +
                `🚗 Автомобиль: _не указан_\n\n` +
                `Давайте найдём ваш автомобиль:`,
                { parse_mode: 'Markdown' }
            );
            await showSearchPrompt(ctx);
            ctx.wizard.selectStep(2);
            return;
        }

        return ctx.wizard.next();
    },

    // ─── Step 1: Handle contact (linking) or car-card button ─────────────────
    async (ctx) => {
        const text = ctx.message?.text;
        const mode = ctx.wizard.state.mode;

        if (text === '🔙 Меню' || text === 'Отмена') {
            return goToMainMenu(ctx);
        }

        // ── not_linked: waiting for phone contact ──
        if (mode === 'not_linked') {
            if (ctx.message?.contact) {
                const phone = ctx.message.contact.phone_number;
                await ctx.reply('⏳ Ищу ваш профиль в системе...');

                const result = await callCRM('sync_user', {
                    telegramId: String(ctx.from.id),
                    username: ctx.from.username,
                    phone
                });

                if (result.status === 0 || result.status === 504) {
                    await ctx.reply(
                        `🔌 *CRM сейчас недоступна*\n\n` +
                        `Ваш номер сохранён. Попробуйте позже — привязка произойдёт автоматически.`,
                        { parse_mode: 'Markdown' }
                    );
                } else if (result.ok && result.data.autoLinked) {
                    await ctx.reply(
                        `✅ *Профиль найден и привязан!*\n\n` +
                        `Водитель: *${result.data.driverName}*\n\n` +
                        `Теперь вам доступны все функции бота 🎉`,
                        { parse_mode: 'Markdown' }
                    );
                } else if (result.ok) {
                    await ctx.reply(
                        `📨 *Запрос отправлен менеджеру*\n\n` +
                        `Автоматически найти не удалось.\n` +
                        `Менеджер привяжет профиль вручную — придёт уведомление.`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await ctx.reply(
                        `❌ Ошибка при отправке. Попробуйте позже.`
                    );
                }
                return goToMainMenu(ctx);
            }

            // text instead of contact
            await ctx.reply(
                '⚠️ Нажмите кнопку *📱 Поделиться номером для привязки*\nили вернитесь в *🔙 Меню*.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // ── linked: waiting for change-car button ──
        if (text === '🔄 Сменить автомобиль') {
            await showSearchPrompt(ctx);
            return ctx.wizard.next();
        }

        await ctx.reply('Нажмите *🔄 Сменить автомобиль* или вернитесь в *🔙 Меню*.', { parse_mode: 'Markdown' });
    },

    // ─── Step 2: Receive plate prefix, search cars ────────────────────────────
    async (ctx) => {
        const text = ctx.message?.text;
        if (!text || text === '🔙 Отмена' || text === 'Отмена' || text === '🔙 Меню') {
            return goToMainMenu(ctx);
        }

        const platePrefix = text.replace(/\s/g, '');
        if (platePrefix.length < 3) {
            await ctx.reply('⚠️ Введите минимум 3 символа госномера. Например: Х111ХХ');
            return;
        }

        await ctx.reply(`🔍 Ищу автомобиль по номеру *${platePrefix.toUpperCase()}*...`, { parse_mode: 'Markdown' });

        const result = await callCRM('search_car_by_plate', { platePrefix });

        if (result.status === 0 || result.status === 504) {
            await ctx.reply('🔌 CRM недоступна. Попробуйте позже.');
            return goToMainMenu(ctx);
        }

        if (!result.ok || !result.data.found || !result.data.cars?.length) {
            await ctx.reply(
                `❌ Автомобиль *${platePrefix.toUpperCase()}* не найден.\n\nВведите другой госномер:`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        ctx.wizard.state.foundCars = result.data.cars;
        const carButtons = result.data.cars.map((c, i) =>
            [`${i + 1}. ${c.brand || ''} ${c.model || ''} — ${c.plate}`]
        );
        carButtons.push(['🔙 Отмена']);

        let msg = `✅ *Найдено ${result.data.cars.length} авто:*\n\n`;
        result.data.cars.forEach((c, i) => {
            msg += `${i + 1}. *${c.brand || ''} ${c.model || ''}*\n   🔑 Госномер: \`${c.plate}\`\n   ${c.color ? `🎨 ${c.color}` : ''} ${c.year ? `| ${c.year} г.` : ''}\n\n`;
        });
        msg += `Выберите автомобиль для привязки:`;

        await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.keyboard(carButtons).resize()
        });

        return ctx.wizard.next();
    },

    // ─── Step 3: User selects a car ───────────────────────────────────────────
    async (ctx) => {
        const text = ctx.message?.text;
        if (!text || text === '🔙 Отмена' || text === 'Отмена' || text === '🔙 Меню') {
            return goToMainMenu(ctx);
        }

        const foundCars = ctx.wizard.state.foundCars || [];
        const match = text.match(/^(\d+)\./);
        const idx = match ? parseInt(match[1], 10) - 1 : -1;

        if (idx < 0 || idx >= foundCars.length) {
            await ctx.reply('⚠️ Выберите автомобиль из списка или нажмите 🔙 Отмена.');
            return;
        }

        const car = foundCars[idx];
        ctx.wizard.state.selectedCar = car;

        await ctx.reply(
            `🚗 *Выбранный автомобиль:*\n\n` +
            `*${car.brand || ''} ${car.model || ''}*\n` +
            `🔑 Госномер: \`${car.plate}\`\n` +
            `${car.color ? `🎨 Цвет: ${car.color}` : ''} ${car.year ? `| ${car.year} г.` : ''}\n\n` +
            `Привязать этот автомобиль к вашему профилю?`,
            {
                parse_mode: 'Markdown',
                ...Markup.keyboard([['✅ Да, привязать'], ['❌ Нет, отмена']]).resize()
            }
        );

        return ctx.wizard.next();
    },

    // ─── Step 4: Confirm and update ───────────────────────────────────────────
    async (ctx) => {
        const text = ctx.message?.text;
        if (!text || text.includes('Нет') || text === 'Отмена' || text === '🔙 Меню') {
            await ctx.reply('Операция отменена.');
            return goToMainMenu(ctx);
        }

        if (!text.includes('Да')) {
            await ctx.reply('⚠️ Нажмите *✅ Да, привязать* или *❌ Нет, отмена*', { parse_mode: 'Markdown' });
            return;
        }

        const car = ctx.wizard.state.selectedCar;
        if (!car) return goToMainMenu(ctx);

        await ctx.reply('⏳ Обновляю автомобиль в карточке...');

        const result = await callCRM('update_driver_car', {
            telegramId: String(ctx.from.id),
            carId: car.id
        });

        if (result.ok && result.data.success) {
            await ctx.reply(
                `✅ *Автомобиль успешно привязан!*\n\n` +
                `*${car.brand || ''} ${car.model || ''}*\n` +
                `🔑 Госномер: \`${car.plate}\``,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.reply(`❌ Ошибка обновления: ${result.data?.error || 'Попробуйте позже'}`);
        }

        return goToMainMenu(ctx);
    }
);

module.exports = carManagementScene;
