const https = require('https');
const http = require('http');
const db = require('../database');
const logger = require('../utils/logger');

const SYNC_INTERVAL_MS = Number.parseInt(process.env.BOT_REGISTRY_SYNC_INTERVAL_MS || '300000', 10);
const SYNC_BATCH_SIZE = 200;
const SYNC_CONCURRENCY = 5;
let syncInProgress = false;

function registrationPayload(user, attemptAutoLink) {
    return {
        telegramId: String(user.telegram_id ?? user.telegramId),
        username: user.username || null,
        firstName: user.first_name ?? user.firstName ?? null,
        lastName: user.last_name ?? user.lastName ?? null,
        phone: user.phone || null,
        phoneVerified: Boolean(user.phone_verified ?? user.phoneVerified),
        attemptAutoLink,
    };
}

function crmRegistrationUrl() {
    const configured = process.env.BOT_ACTIONS_URL || process.env.CRM_WEBHOOK_URL;
    if (configured) {
        try {
            const url = new URL(configured);
            return `${url.protocol}//${url.host}/api/webhook/telegram`;
        } catch { /* use local service fallback */ }
    }
    return 'http://localhost:3002/api/webhook/telegram';
}

function postRegistration(payload) {
    return new Promise((resolve) => {
        const signature = process.env.BOT_CRM_SECRET;
        if (!signature) return resolve({ ok: false, error: new Error('BOT_CRM_SECRET is not configured') });
        const body = JSON.stringify({ action: 'register_bot_user', payload });
        const parsed = new URL(crmRegistrationUrl());
        const transport = parsed.protocol === 'https:' ? https : http;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const request = transport.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'x-bot-signature': signature,
            },
        }, (response) => {
            let responseBody = '';
            response.on('data', chunk => { responseBody += chunk; });
            response.on('end', () => {
                let data = {};
                try { data = JSON.parse(responseBody); } catch { /* keep empty response */ }
                finish({ ok: response.statusCode >= 200 && response.statusCode < 300, data });
            });
        });
        request.setTimeout(15000, () => request.destroy(new Error('CRM bot registry timeout')));
        request.on('error', error => finish({ ok: false, error }));
        request.write(body);
        request.end();
    });
}

class UserService {
    // Register or update user
    async registerUser(userData) {
        const { id, username, first_name, last_name } = userData;
        await db.registerUser(id, username, first_name, last_name);
        try {
            const localUser = await db.getUserByTelegramId(id);
            const result = await this.registerUserInCrm(localUser);
            if (!result.ok) logger.error(`[BotRegistry] CRM registration failed for TG ${id}`);
        } catch (error) {
            logger.error(`[BotRegistry] Could not register TG ${id}: ${error?.message || error}`);
        }
    }

    async registerUserInCrm(user, { attemptAutoLink = true } = {}) {
        const payload = registrationPayload(user, attemptAutoLink);
        const result = await postRegistration(payload);
        if (result.ok) await db.markUserRegisteredInCrm(payload.telegramId);
        return result;
    }

    async syncPendingCrmUsers() {
        if (syncInProgress) return { skipped: true };
        syncInProgress = true;
        try {
            const users = await db.getUsersPendingCrmRegistration(SYNC_BATCH_SIZE);
            let synced = 0;
            let failed = 0;
            for (let offset = 0; offset < users.length; offset += SYNC_CONCURRENCY) {
                const batch = users.slice(offset, offset + SYNC_CONCURRENCY);
                const results = await Promise.all(batch.map(user =>
                    this.registerUserInCrm(user, { attemptAutoLink: false })
                ));
                synced += results.filter(result => result.ok).length;
                failed += results.filter(result => !result.ok).length;
            }
            if (users.length > 0) logger.info(`[BotRegistry] historical sync: ${synced} synced, ${failed} pending`);
            if (users.length === SYNC_BATCH_SIZE && failed === 0) {
                const continuation = setTimeout(() => {
                    this.syncPendingCrmUsers().catch(error => {
                        logger.error(`[BotRegistry] continuation failed: ${error?.message || error}`);
                    });
                }, 1000);
                continuation.unref();
            }
            return { synced, failed };
        } catch (error) {
            logger.error(`[BotRegistry] historical sync failed: ${error?.message || error}`);
            return { synced: 0, failed: 1 };
        } finally {
            syncInProgress = false;
        }
    }

    startPeriodicCrmSync() {
        const timer = setInterval(() => {
            this.syncPendingCrmUsers().catch(error => {
                logger.error(`[BotRegistry] scheduled sync failed: ${error?.message || error}`);
            });
        }, SYNC_INTERVAL_MS);
        timer.unref();
        return timer;
    }

    async setUserState(telegramId, state) {
        await db.setUserState(telegramId, state);
    }

    async getUserState(telegramId) {
        return await db.getUserState(telegramId);
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

    async getUsersPendingCrmRegistration(limit = 200) {
        return await db.getUsersPendingCrmRegistration(limit);
    }

    async markUserRegisteredInCrm(telegramId) {
        return await db.markUserRegisteredInCrm(telegramId);
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
            const actions = await db.allUserActivity(telegramId.toString());
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
