const { Markup } = require('telegraf');
const userService = require('../services/userService');
const sheetsService = require('../services/sheets');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Start the connection flow
 */
async function startConnectionFlow(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username;

    logger.info(`Starting connection flow for user ${userId}`);

    // Update local DB instantly
    await userService.setUserState(userId, 'CONNECTION_MODE');

    const message = `Для подключения в парк нам потребуются следующие данные:
- Номер телефона
- Фото водительского удостоверения (ВУ)
- Фото свидетельства о регистрации транспортного средства (СТС)

Пожалуйста, отправляйте данные сообщениями. Вы также можете нажать кнопку ниже для связи с менеджером.`;

    await ctx.reply(message, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('Отправить данные в парк', 'https://t.me/yokopark')]
        ])
    });

    // Record intent asynchronously
    sheetsService.upsertConnectionRow(userId, username, {
        Status: 'Connection Requested',
        Notes: `Initial Connection Request: ${new Date().toLocaleString('ru-RU')}`
    }).catch(err => logger.error('Sheets connection init failed:', err));
}

/**
 * Handle incoming data during connection mode
 */
async function handleConnectionData(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    let dataToUpdate = { Status: 'Connection Requested' };
    let typeFound = false;

    // Contact mapping
    if (ctx.message.contact) {
        dataToUpdate['phone'] = ctx.message.contact.phone_number;
        dataToUpdate['Phone Number'] = ctx.message.contact.phone_number; // Keep for Sheets
        typeFound = 'телефон';
    }
    // Photo mapping (VU / STS)
    else if (ctx.message.photo) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileId = photo.file_id;
        const fileLink = `https://api.telegram.org/file/bot${config.botToken}/${fileId}`;

        // Simple routing based on existing columns in Sheets
        const response = await sheetsService.sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `'Подключиться из Бота'!B:G`
        });
        const rows = response.data.values || [];
        const userRow = rows.find(row => row[0] === userId.toString());

        if (userRow && userRow[4]) { // Column F (index 4 in B:G range) is VU Link
            dataToUpdate['sts_link'] = fileLink;
            dataToUpdate['STS Link'] = fileLink; // Keep for Sheets
            typeFound = 'фото СТС';
        } else {
            dataToUpdate['vu_link'] = fileLink;
            dataToUpdate['VU Link'] = fileLink; // Keep for Sheets
            typeFound = 'фото ВУ';
        }
    }
    // Text mapping (Full Name)
    else if (ctx.message.text && !['🚗 Подключиться', '🔙 Меню', '📊 Опрос качества', '🛠 Поддержка', '📖 Новости', '🚖 Yandex Taxi Fun'].includes(ctx.message.text)) {
        dataToUpdate['full_name'] = ctx.message.text;
        dataToUpdate['Full Name'] = ctx.message.text; // Keep for Sheets
        typeFound = 'ФИО';
    }

    if (typeFound) {
        // Save locally - only use snake_case keys for SQLite
        const localData = {
            status: dataToUpdate.Status
        };
        if (dataToUpdate.phone) localData.phone = dataToUpdate.phone;
        if (dataToUpdate.full_name) localData.full_name = dataToUpdate.full_name;
        if (dataToUpdate.vu_link) localData.vu_link = dataToUpdate.vu_link;
        if (dataToUpdate.sts_link) localData.sts_link = dataToUpdate.sts_link;

        await userService.upsertConnectionLocal(userId, username, localData);

        // Save to Sheets (async)
        sheetsService.upsertConnectionRow(userId, username, dataToUpdate).catch(err => logger.error('Sync to Sheets failed:', err));

        // Notify Admin (async to avoid delay)
        notifyAdmin(ctx, typeFound).catch(err => logger.error('Admin notification failed:', err));

        await ctx.reply(`✅ Получили ${typeFound}. Информация обновлена в вашей заявке.`);
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

Данные сохранены в базе и Google Sheets.`;

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
