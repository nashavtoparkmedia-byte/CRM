const db = require('../database');
const logger = require('../utils/logger');

class Analytics {
    // Get user statistics
    async getUserStats() {
        try {
            // Total users
            const totalResult = await db.getTotalUsers();
            const total = totalResult ? totalResult.count : 0;

            // New users today
            const todayResult = await db.getUsersToday();
            const today = todayResult ? todayResult.count : 0;

            // New users yesterday
            const yesterdayResult = await db.getUsersYesterday();
            const yesterday = yesterdayResult ? yesterdayResult.count : 0;

            // New users last 7 days
            const last7DaysResult = await db.getUsersLast7Days();
            const last7Days = last7DaysResult ? last7DaysResult.count : 0;

            return {
                total,
                today,
                yesterday,
                last7Days
            };
        } catch (err) {
            logger.error('Error getting user stats:', err);
            return { total: 0, today: 0, yesterday: 0, last7Days: 0 };
        }
    }

    // Get action statistics
    async getActionStats() {
        try {
            // Total actions
            const totalResult = await db.getTotalActions();
            const total = totalResult ? totalResult.count : 0;

            // Actions by type
            const actionsByType = await db.allActionTypeCounts();

            // Actions today
            const todayResult = await db.getActionsToday();
            const today = todayResult ? todayResult.count : 0;

            return {
                total,
                today,
                byType: actionsByType || []
            };
        } catch (err) {
            logger.error('Error getting action stats:', err);
            return { total: 0, today: 0, byType: [] };
        }
    }

    // Get conversion statistics (start -> survey complete)
    async getConversionStats() {
        try {
            // Users who started survey
            const startedResult = await db.getStartedSurveyCount();
            const started = startedResult ? startedResult.count : 0;

            // Users who completed survey
            const completedResult = await db.getCompletedSurveyCount();
            const completed = completedResult ? completedResult.count : 0;

            // Conversion rate
            const conversionRate = started > 0 ? ((completed / started) * 100).toFixed(2) : 0;

            return {
                started,
                completed,
                conversionRate
            };
        } catch (err) {
            logger.error('Error getting conversion stats:', err);
            return { started: 0, completed: 0, conversionRate: 0 };
        }
    }

    // Get full analytics report
    async getFullReport() {
        const [userStats, actionStats, conversionStats] = await Promise.all([
            this.getUserStats(),
            this.getActionStats(),
            this.getConversionStats()
        ]);

        return {
            users: userStats,
            actions: actionStats,
            conversion: conversionStats
        };
    }

    // Format analytics for Telegram message
    formatReport(report) {
        let msg = '📊 *Аналитика бота*\n\n';

        // Users section
        msg += '👥 *Пользователи:*\n';
        msg += `• Всего: ${report.users.total}\n`;
        msg += `• Сегодня: ${report.users.today}\n`;
        msg += `• Вчера: ${report.users.yesterday}\n`;
        msg += `• За 7 дней: ${report.users.last7Days}\n\n`;

        // Actions section
        msg += '📋 *Действия:*\n';
        msg += `• Всего: ${report.actions.total}\n`;
        msg += `• Сегодня: ${report.actions.today}\n`;
        if (report.actions.byType.length > 0) {
            msg += `• По типам:\n`;
            report.actions.byType.forEach(item => {
                msg += `  - ${item.action_type}: ${item.count}\n`;
            });
        }
        msg += '\n';

        // Conversion section
        msg += '🎯 *Конверсия:*\n';
        msg += `• Начали опрос: ${report.conversion.started}\n`;
        msg += `• Завершили опрос: ${report.conversion.completed}\n`;
        msg += `• Конверсия: ${report.conversion.conversionRate}%\n`;

        return msg;
    }
}

module.exports = new Analytics();
