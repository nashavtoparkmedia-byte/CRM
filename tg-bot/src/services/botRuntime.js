const crypto = require('crypto');
const logger = require('../utils/logger');

const DEFAULT_ALLOWED_UPDATES = ['message', 'callback_query'];
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const RECENT_UPDATE_LIMIT = 2_000;
const IDENTITY_STARTUP_ATTEMPTS = 3;
const IDENTITY_RETRY_DELAY_MS = 1_000;

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
    let botIdentity = null;
    // An update_id is recorded as COMPLETED only after its handler chain has
    // finished successfully. While it runs it lives in `inFlightUpdates`, whose
    // entry is the single owner execution; a concurrent delivery of the same id
    // joins that promise instead of executing anything itself. A failure removes
    // the in-flight entry and records nothing, so Telegram's retry is free to
    // execute the update again.
    const completedUpdateIds = new Map();
    const inFlightUpdates = new Map();

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

    function updateKey(updateId) {
        if (updateId === undefined || updateId === null) return null;
        return String(updateId);
    }

    function markCompleted(key) {
        completedUpdateIds.set(key, Date.now());
        while (completedUpdateIds.size > RECENT_UPDATE_LIMIT) {
            const oldest = completedUpdateIds.keys().next().value;
            completedUpdateIds.delete(oldest);
        }
    }

    /**
     * Establish Telegraf's `botInfo` once, from a proven getMe.
     *
     * Telegraf 4.16.3 fills `botInfo` lazily inside `handleUpdate` and memoises
     * the call in `botInfoCall`, which it never clears. So the first update that
     * arrives without `botInfo` triggers a getMe, and if that getMe rejects the
     * rejected promise stays cached and every later update rejects with it until
     * the process restarts. Webhook mode never calls `launch()`, so nothing else
     * populates it. We therefore set `botInfo` ourselves before accepting
     * updates, and never cache a failed attempt.
     */
    async function ensureBotIdentity() {
        const instance = requireBot();
        if (botIdentity) return botIdentity;
        if (instance.botInfo && Number.isInteger(instance.botInfo.id) && instance.botInfo.username) {
            botIdentity = instance.botInfo;
            return botIdentity;
        }
        const me = await instance.telegram.getMe();
        if (!me || !Number.isInteger(me.id) || !me.username) {
            throw new Error('TELEGRAM_BOT_IDENTITY_UNPROVEN');
        }
        instance.botInfo = me;
        botIdentity = me;
        return botIdentity;
    }

    function identityEstablished() {
        return Boolean(botIdentity);
    }

    async function handleUpdate(update) {
        const instance = requireBot();
        // Fail closed until identity is proven, so no update can fall into
        // Telegraf's lazy getMe. The watchdog keeps retrying, so this clears
        // without a restart.
        if (!identityEstablished()) {
            throw new Error('TELEGRAM_BOT_IDENTITY_UNPROVEN');
        }

        const key = updateKey(update?.update_id);
        if (key === null) {
            // Nothing to deduplicate on. Run it, but never record a reservation
            // that a later update could collide with.
            lastUpdateAt = new Date().toISOString();
            await instance.handleUpdate(update);
            return { duplicate: false };
        }

        if (completedUpdateIds.has(key)) return { duplicate: true };

        const owner = inFlightUpdates.get(key);
        if (owner) return owner;

        // The reservation is installed synchronously with creating the promise:
        // there is no await between the two, so no concurrent delivery can slip
        // past it and start a second execution.
        const execution = (async () => {
            lastUpdateAt = new Date().toISOString();
            await instance.handleUpdate(update);
            markCompleted(key);
            return { duplicate: false };
        })();
        inFlightUpdates.set(key, execution);
        execution.catch(() => {}).then(() => {
            inFlightUpdates.delete(key);
        });
        return execution;
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
            // Identity first: while it is missing every update is refused, so
            // recovering it is the most valuable thing this tick can do.
            await ensureBotIdentity();
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
            // Bounded attempt to prove identity before any update is accepted.
            // A flaky egress must not wedge startup: if every attempt fails we
            // still arm the watchdog, and `handleUpdate` refuses updates in the
            // meantime rather than letting Telegraf take the lazy path.
            for (let attempt = 1; attempt <= IDENTITY_STARTUP_ATTEMPTS; attempt += 1) {
                try {
                    const me = await ensureBotIdentity();
                    runtimeLogger.info(`[Webhook] bot identity established: @${me.username}`);
                    break;
                } catch (error) {
                    lastRuntimeError = error.message;
                    runtimeLogger.error(
                        `[Webhook] bot identity attempt ${attempt}/${IDENTITY_STARTUP_ATTEMPTS}`
                        + ` failed: ${error.message}`
                    );
                    if (attempt < IDENTITY_STARTUP_ATTEMPTS) {
                        await new Promise((resolve) => setTimeout(resolve, IDENTITY_RETRY_DELAY_MS * attempt));
                    }
                }
            }
            if (!identityEstablished()) {
                runtimeLogger.error(
                    '[Webhook] bot identity unproven; updates are refused until the watchdog recovers it'
                );
            }
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
        ensureBotIdentity,
        ensureWebhook,
        getStatus,
        handleUpdate,
        identityEstablished,
        matchesToken,
        start,
        stop,
        validateWebhookSecret,
        get mode() { return mode; },
        get inFlightUpdateCount() { return inFlightUpdates.size; },
        get completedUpdateCount() { return completedUpdateIds.size; }
    };
}

const runtime = createBotRuntime();

module.exports = runtime;
module.exports.createBotRuntime = createBotRuntime;
module.exports.deriveWebhookSecret = deriveWebhookSecret;
