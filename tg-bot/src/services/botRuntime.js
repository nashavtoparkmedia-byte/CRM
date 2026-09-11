const crypto = require('crypto');
const logger = require('../utils/logger');

const DEFAULT_ALLOWED_UPDATES = ['message', 'callback_query'];
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const RECENT_UPDATE_LIMIT = 2_000;

function deriveWebhookSecret(botToken) {
    return crypto
        .createHash('sha256')
        .update(`yoko-telegram-webhook:${botToken}`)
        .digest('base64url');
}

function safeEqual(left, right) {
    if (!left || !right) return false;
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createBotRuntime(options = {}) {
    const env = options.env || process.env;
    const runtimeLogger = options.logger || logger;
    const botToken = options.botToken || env.BOT_TOKEN || '';
    const mode = String(env.BOT_UPDATE_MODE || 'polling').toLowerCase();
    const webhookUrl = String(env.TELEGRAM_WEBHOOK_URL || '').trim();
    const webhookSecret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim() || deriveWebhookSecret(botToken);
    const checkIntervalMs = Math.max(
        10_000,
        Number.parseInt(env.BOT_WEBHOOK_CHECK_INTERVAL_MS || DEFAULT_CHECK_INTERVAL_MS, 10)
    );

    let bot = null;
    let watchdog = null;
    let repairInFlight = null;
    let pollingStarted = false;
    let lastUpdateAt = null;
    let lastCheckAt = null;
    let lastRepairAt = null;
    let lastRepairReason = null;
    let lastRuntimeError = null;
    const recentUpdateIds = new Map();

    function attach(instance) {
        bot = instance;
    }

    function requireBot() {
        if (!bot) throw new Error('Telegram bot runtime is not attached');
        return bot;
    }

    function assertWebhookConfig() {
        if (mode !== 'webhook') return;
        if (!webhookUrl.startsWith('https://')) {
            throw new Error('TELEGRAM_WEBHOOK_URL must be an HTTPS URL in webhook mode');
        }
        if (!botToken) throw new Error('BOT_TOKEN is required');
    }

    function matchesToken(token) {
        return Boolean(token && botToken && safeEqual(token, botToken));
    }

    function validateWebhookSecret(value) {
        return safeEqual(value, webhookSecret);
    }

    function rememberUpdate(updateId) {
        if (updateId === undefined || updateId === null) return true;
        const key = String(updateId);
        if (recentUpdateIds.has(key)) return false;
        recentUpdateIds.set(key, Date.now());
        if (recentUpdateIds.size > RECENT_UPDATE_LIMIT) {
            const oldest = recentUpdateIds.keys().next().value;
            recentUpdateIds.delete(oldest);
        }
        return true;
    }

    async function handleUpdate(update) {
        const instance = requireBot();
        if (!rememberUpdate(update?.update_id)) {
            return { duplicate: true };
        }
        lastUpdateAt = new Date().toISOString();
        await instance.handleUpdate(update);
        return { duplicate: false };
    }

    async function readTelegramStatus() {
        const instance = requireBot();
        const [me, info] = await Promise.all([
            instance.telegram.getMe(),
            instance.telegram.getWebhookInfo()
        ]);
        lastCheckAt = new Date().toISOString();
        return { me, info };
    }

    function webhookNeedsRepair(info) {
        if (!info || info.url !== webhookUrl) return 'webhook_url_mismatch';
        const lastErrorDate = Number(info.last_error_date || 0) * 1000;
        if (lastErrorDate && Date.now() - lastErrorDate < checkIntervalMs * 3) {
            return 'recent_telegram_delivery_error';
        }
        const allowed = Array.isArray(info.allowed_updates) ? info.allowed_updates : [];
        if (!DEFAULT_ALLOWED_UPDATES.every((item) => allowed.includes(item))) {
            return 'allowed_updates_mismatch';
        }
        return null;
    }

    async function ensureWebhook(reason = 'manual') {
        assertWebhookConfig();
        if (mode !== 'webhook') {
            throw new Error('Webhook recovery is unavailable while BOT_UPDATE_MODE is not webhook');
        }
        if (repairInFlight) return repairInFlight;

        repairInFlight = (async () => {
            const instance = requireBot();
            runtimeLogger.warn(`[Webhook] registering ${webhookUrl} (reason: ${reason})`);
            await instance.telegram.setWebhook(webhookUrl, {
                secret_token: webhookSecret,
                allowed_updates: DEFAULT_ALLOWED_UPDATES,
                drop_pending_updates: false
            });
            const info = await instance.telegram.getWebhookInfo();
            if (info.url !== webhookUrl) {
                throw new Error(`Telegram returned unexpected webhook URL: ${info.url || '<empty>'}`);
            }
            lastRepairAt = new Date().toISOString();
            lastRepairReason = reason;
            lastRuntimeError = null;
            runtimeLogger.info(`[Webhook] active; pending updates: ${info.pending_update_count || 0}`);
            return info;
        })().catch((error) => {
            lastRuntimeError = error.message;
            runtimeLogger.error(`[Webhook] repair failed: ${error.message}`);
            throw error;
        }).finally(() => {
            repairInFlight = null;
        });

        return repairInFlight;
    }

    async function checkAndRepair() {
        if (mode !== 'webhook') return getStatus();
        try {
            const { info } = await readTelegramStatus();
            const reason = webhookNeedsRepair(info);
            if (reason) await ensureWebhook(reason);
        } catch (error) {
            lastRuntimeError = error.message;
            runtimeLogger.error(`[Webhook] health check failed: ${error.message}`);
        }
        return getStatus();
    }

    async function getStatus() {
        try {
            const { me, info } = await readTelegramStatus();
            const repairReason = mode === 'webhook' ? webhookNeedsRepair(info) : null;
            return {
                mode,
                healthy: mode === 'webhook' ? !repairReason : pollingStarted,
                username: me.username || null,
                webhookUrl: info.url || '',
                expectedWebhookUrl: mode === 'webhook' ? webhookUrl : '',
                pendingUpdateCount: info.pending_update_count || 0,
                allowedUpdates: info.allowed_updates || [],
                lastTelegramErrorAt: info.last_error_date
                    ? new Date(info.last_error_date * 1000).toISOString()
                    : null,
                lastTelegramError: info.last_error_message || null,
                lastUpdateAt,
                lastCheckAt,
                lastRepairAt,
                lastRepairReason,
                runtimeError: lastRuntimeError,
                repairRecommended: Boolean(repairReason)
            };
        } catch (error) {
            lastRuntimeError = error.message;
            return {
                mode,
                healthy: false,
                username: null,
                webhookUrl: '',
                expectedWebhookUrl: mode === 'webhook' ? webhookUrl : '',
                pendingUpdateCount: null,
                allowedUpdates: [],
                lastTelegramErrorAt: null,
                lastTelegramError: null,
                lastUpdateAt,
                lastCheckAt,
                lastRepairAt,
                lastRepairReason,
                runtimeError: error.message,
                repairRecommended: mode === 'webhook'
            };
        }
    }

    async function start() {
        const instance = requireBot();
        if (mode === 'webhook') {
            assertWebhookConfig();
            await ensureWebhook('startup');
            if (!watchdog) {
                watchdog = setInterval(checkAndRepair, checkIntervalMs);
                watchdog.unref?.();
            }
            runtimeLogger.info(`[Webhook] watchdog armed every ${checkIntervalMs / 1000}s`);
            return;
        }

        await instance.telegram.deleteWebhook({ drop_pending_updates: false }).catch((error) => {
            runtimeLogger.warn(`[Polling] deleteWebhook failed: ${error.message}`);
        });
        instance.launch().catch((error) => {
            pollingStarted = false;
            lastRuntimeError = error.message;
            runtimeLogger.error(`[Polling] launch failed: ${error.message}`);
        });
        pollingStarted = true;
        runtimeLogger.info('[Polling] receiver launched');
    }

    function stop() {
        if (watchdog) clearInterval(watchdog);
        watchdog = null;
        if (mode !== 'webhook' && pollingStarted && bot) {
            try {
                bot.stop('shutdown');
            } catch (error) {
                runtimeLogger.warn(`[Polling] stop failed: ${error.message}`);
            }
        }
        pollingStarted = false;
    }

    return {
        attach,
        checkAndRepair,
        ensureWebhook,
        getStatus,
        handleUpdate,
        matchesToken,
        start,
        stop,
        validateWebhookSecret,
        get mode() { return mode; }
    };
}

const runtime = createBotRuntime();

module.exports = runtime;
module.exports.createBotRuntime = createBotRuntime;
module.exports.deriveWebhookSecret = deriveWebhookSecret;
