const db = require('../database');
const logger = require('../utils/logger');

class UserService {
    // Register or update user
    async registerUser(userData) {
        const { id, username, first_name, last_name } = userData;
        await db.registerUser(id, username, first_name, last_name);
    }

    async setUserState(telegramId, state) {
        await db.setUserState(telegramId, state);
    }

    async getUserState(telegramId) {
        return await db.getUserState(telegramId);
    }

    async upsertConnectionLocal(telegramId, username, data) {
        await db.upsertConnectionLocal(telegramId, username, data);
    }

    // Update user data
    async updateUser(telegramId, data) {
        await db.updateUser(telegramId, data);
    }

    // Get user by telegram ID
    async getUserByTelegramId(telegramId) {
        return await db.getUserByTelegramId(telegramId);
    }

    // Get all users for broadcast
    async getAllUsers() {
        return await db.getAllUsers();
    }

    // Get recent users
    async getRecentUsers(limit = 10) {
        return await db.getRecentUsers(limit);
    }

    // Log user action
    async logAction(userId, username, actionType, payload = {}) {
        await db.logAction(userId, username, actionType, payload);
    }

    // Get user activity statistics
    async getUserActivity(telegramId) {
        try {
            const actions = await db.all(
                `SELECT action_type, COUNT(*) as count 
                 FROM actions 
                 WHERE telegram_id = ? 
                 GROUP BY action_type`,
                [telegramId.toString()]
            );
            return actions;
        } catch (err) {
            logger.error('Error getting user activity:', err);
            return [];
        }
    }
    // Reset user state and flow
    async resetUserFlow(telegramId) {
        await this.setUserState(telegramId, 'IDLE');
        logger.info(`Reset flow for user ${telegramId}`);
    }
}

module.exports = new UserService();
