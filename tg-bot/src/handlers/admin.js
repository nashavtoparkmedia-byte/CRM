const config = require('../config');
const userService = require('../services/userService');
const analytics = require('../services/analytics');
const logger = require('../utils/logger');

// Check if user is admin
function isAdmin(userId) {
    return userId === config.adminId;
}

// Format users list
function formatUsersList(users) {
    if (users.length === 0) {
        return 'Пока нет пользователей.';
    }
    
    let msg = '';
    users.forEach((u, i) => {
        msg += `${i + 1}. ID: \`${u.telegram_id}\`, @${u.username || 'no_username'}\n`;
        msg += `   Имя: ${u.first_name || '-'} ${u.last_name || ''}\n`;
        msg += `   Дата: ${new Date(u.created_at).toLocaleString('ru-RU')}\n\n`;
    });
    return msg;
}

// Format actions list
function formatActionsList(actions) {
    if (actions.length === 0) {
        return 'Пока нет действий.';
    }
    
    let msg = '';
    actions.forEach((a, i) => {
        msg += `${i + 1}. User \`${a.telegram_id}\` → ${a.action_type}\n`;
        msg += `   Время: ${new Date(a.created_at).toLocaleString('ru-RU')}\n`;
        if (a.payload) {
            try {
                const payload = JSON.parse(a.payload);
                if (Object.keys(payload).length > 0) {
                    msg += `   Данные: \`${JSON.stringify(payload)}\`\n`;
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
        msg += '\n';
    });
    return msg;
}

// /admin - Show admin menu
async function handleAdmin(ctx) {
    try {
        if (!isAdmin(ctx.from.id)) {
            return ctx.reply('У вас нет доступа к админ-панели.');
        }

        const menu = `
🔧 *Админ-панель*

Доступные команды:
/stats - Общая статистика
/users - Последние 10 пользователей
/actions - Последние 20 действий
/broadcast [сообщение] - Рассылка всем
        `;

        await ctx.reply(menu, { parse_mode: 'Markdown' });
    } catch (err) {
        logger.error('ADMIN ERROR:', err);
        ctx.reply('Ошибка при получении данных. Проверьте сервер.');
    }
}

// /stats - Show statistics
async function handleStats(ctx) {
    try {
        if (!isAdmin(ctx.from.id)) {
            return ctx.reply('У вас нет доступа.');
        }

        const report = await analytics.getFullReport();
        const message = analytics.formatReport(report);

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
        logger.error('Error in stats handler:', err);
        await ctx.reply('Ошибка при получении статистики.');
    }
}

// /users - Show recent users
async function handleUsers(ctx) {
    try {
        if (!isAdmin(ctx.from.id)) {
            return ctx.reply('У вас нет доступа.');
        }

        const users = await userService.getRecentUsers(10);
        const message = '📊 *Последние пользователи:*\n\n' + formatUsersList(users);

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
        logger.error('Error in users handler:', err);
        await ctx.reply('Ошибка при получении списка пользователей.');
    }
}

// /actions - Show recent actions
async function handleActions(ctx) {
    try {
        if (!isAdmin(ctx.from.id)) {
            return ctx.reply('У вас нет доступа.');
        }

        const actions = await userService.getRecentUsers(20); // This is wrong, should be from db
        // Fix: get actions directly
        const db = require('../database');
        const recentActions = await db.getRecentActions(20);
        const message = '📋 *Последние действия:*\n\n' + formatActionsList(recentActions);

        await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
        logger.error('Error in actions handler:', err);
        await ctx.reply('Ошибка при получении списка действий.');
    }
}

// /broadcast - Send message to all users
async function handleBroadcast(ctx) {
    try {
        if (!isAdmin(ctx.from.id)) {
            return ctx.reply('У вас нет доступа.');
        }

        const message = ctx.message.text.replace('/broadcast', '').trim();
        
        if (!message) {
            return ctx.reply('Использование: /broadcast [ваше сообщение]');
        }

        const users = await userService.getAllUsers();
        let sent = 0;
        let failed = 0;

        await ctx.reply(`Начинаю рассылку для ${users.length} пользователей...`);

        for (const user of users) {
            try {
                await ctx.telegram.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' });
                sent++;
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
                failed++;
                logger.error(`Failed to send to ${user.telegram_id}:`, err.message);
            }
        }

        await ctx.reply(`✅ Рассылка завершена!\nОтправлено: ${sent}\nНе удалось: ${failed}`);
    } catch (err) {
        logger.error('Error in broadcast handler:', err);
        await ctx.reply('Ошибка при рассылке.');
    }
}

module.exports = {
    handleAdmin,
    handleStats,
    handleUsers,
    handleActions,
    handleBroadcast
};
