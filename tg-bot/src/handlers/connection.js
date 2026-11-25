const { Markup } = require('telegraf');
const userService = require('../services/userService');
const logger = require('../utils/logger');

async function syncProfileToCrm(userId) {
    const user = await userService.getUserByTelegramId(userId);
    if (!user || typeof userService.registerUserInCrm !== 'function') {
        throw new Error('CRM_REGISTRATION_CONTRACT_UNAVAILABLE');
    }
    const result = await userService.registerUserInCrm(user);
    if (!result?.ok) throw new Error('CRM_REGISTRATION_FAILED');
    return result;
}

/**
 * Start the connection flow
 */
async function startConnectionFlow(ctx) {
    const userId = ctx.from.id;

    logger.info(`Starting connection flow for user ${userId}`);

    // Update local DB instantly
    await userService.setUserState(userId, 'CONNECTION_MODE');

    // CRM is the canonical registration store. A failed CRM write must not be
    // presented to the driver as a successful registration.
    try {
        await syncProfileToCrm(userId);
    } catch (error) {
        logger.error(`CRM registration failed for ${userId}: ${error?.message || error}`);
        await ctx.reply('Не удалось зарегистрировать профиль в CRM. Повторите попытку позже.');
        return;
    }

    const message = `🎁 *Акция — первые 14 дней без комиссии!*\n\nПодключитесь сейчас и начните работать на выгодных условиях.\n\nДля подключения в парк нам потребуются следующие данные:\n— Номер телефона\n— Фото водительского удостоверения (ВУ)\n— Фото свидетельства о регистрации транспортного средства (СТС)\n\nОтправляйте данные сообщениями или нажмите кнопку ниже для связи с менеджером.`;

    await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('Отправить данные в парк', 'https://t.me/yokopark')]
        ])
    });

}

/**
 * Handle incoming data during connection mode
 */
async function handleConnectionData(ctx) {
    const userId = ctx.from.id;
    let dataToUpdate = { status: 'Connection Requested' };
    let typeFound = false;

    // Contact mapping
    if (ctx.message.contact) {
        dataToUpdate['phone'] = ctx.message.contact.phone_number;
        typeFound = 'телефон';
    }
    // Photo mapping (VU / STS)
    else if (ctx.message.photo) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileId = photo.file_id;
        // Keep only the Telegram file id locally. The bot's awaited CRM
        // forwarding middleware persists the attachment in the canonical CRM;
        // never construct a URL containing BOT_TOKEN or query a legacy external
        // store to guess whether this is a VU or STS photo.
        const localUser = await userService.getUserByTelegramId(userId);
        if (localUser?.vu_link) {
            dataToUpdate['sts_link'] = fileId;
            typeFound = 'фото СТС';
        } else {
            dataToUpdate['vu_link'] = fileId;
            typeFound = 'фото ВУ';
        }
    }
    // Text mapping (Full Name)
    else if (ctx.message.text && !['🚗 Подключиться', '🔙 Меню', '📊 Опрос качества', '🛠 Поддержка', '📖 Новости', '🚖 Yandex Taxi Fun'].includes(ctx.message.text)) {
        dataToUpdate['full_name'] = ctx.message.text;
        typeFound = 'ФИО';
    }

    if (typeFound) {
        await userService.updateUser(userId, dataToUpdate);
        let crmRecorded = false;
        try {
            await syncProfileToCrm(userId);
            crmRecorded = true;
        } catch (error) {
            logger.error(`CRM registration failed for ${userId}: ${error?.message || error}`);
        }

        // Notify Admin (async to avoid delay)
        notifyAdmin(ctx, typeFound).catch(err => logger.error('Admin notification failed:', err));

        if (crmRecorded) {
            await ctx.reply(`✅ Получили ${typeFound}. Профиль подтверждён CRM.`);
        } else {
            await ctx.reply(`Получили ${typeFound}, но CRM пока не подтвердил запись. Регистрация не завершена; повторите позже.`);
        }
    }
}

/**
 * Notify admin @yokopark (ID: 316425068)
 */
async function notifyAdmin(ctx, type) {
    const ADMIN_TARGET = 316425068;
    const userId = ctx.from.id;
    const username = ctx.from.username || 'N/A';
    const fullName = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');

    const escapeHTML = (str) => String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));

    const safeUsername = escapeHTML(username);
    const safeFullName = escapeHTML(fullName);

    // Use HTML for more reliable parsing with special characters in username
    const message = `🔔 <b>Обновление заявки на подключение!</b>
<b>Пользователь:</b> @${safeUsername} (${safeFullName})
<b>ID:</b> <code>${userId}</code>
<b>Получено:</b> ${type}

Данные получены и переданы в CRM на обработку.`;

    try {
        await ctx.telegram.sendMessage(ADMIN_TARGET, message, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.url('Открыть профиль', `tg://user?id=${userId}`)]
            ])
        });
    } catch (err) {
        logger.error(`Admin notification failed for ${userId}:`, err.message);
    }
}

module.exports = {
    startConnectionFlow,
    handleConnectionData
};
