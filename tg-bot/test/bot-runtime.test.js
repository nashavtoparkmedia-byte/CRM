const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotRuntime, deriveWebhookSecret } = require('../src/services/botRuntime');

function createFixture(overrides = {}) {
    const calls = [];
    let webhookInfo = {
        url: '',
        pending_update_count: 16,
        allowed_updates: []
    };
    const handled = [];
    const bot = {
        telegram: {
            async getMe() {
                return { id: 1, username: 'yoko_park_bot' };
            },
            async getWebhookInfo() {
                return { ...webhookInfo };
            },
            async setWebhook(url, options) {
                calls.push({ url, options });
                webhookInfo = {
                    ...webhookInfo,
                    url,
                    allowed_updates: options.allowed_updates
                };
                return true;
            },
            async deleteWebhook() {
                webhookInfo.url = '';
                return true;
            }
        },
        async handleUpdate(update) {
            handled.push(update.update_id);
        },
        launch() {
            return new Promise(() => {});
        },
        stop() {}
    };
    const runtime = createBotRuntime({
        botToken: '123:test-token',
        env: {
            BOT_TOKEN: '123:test-token',
            BOT_UPDATE_MODE: 'webhook',
            TELEGRAM_WEBHOOK_URL: 'https://admin.example.test/api/telegram/webhook',
            BOT_WEBHOOK_CHECK_INTERVAL_MS: '10000',
            ...overrides
        },
        logger: { info() {}, warn() {}, error() {} }
    });
    runtime.attach(bot);
    return { runtime, calls, handled, getWebhookInfo: () => webhookInfo };
}

test('derives a stable Telegram-compatible webhook secret', () => {
    const first = deriveWebhookSecret('123:test-token');
    const second = deriveWebhookSecret('123:test-token');
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{1,256}$/);
});

test('registers the webhook without dropping queued updates', async () => {
    const { runtime, calls, getWebhookInfo } = createFixture();
    await runtime.ensureWebhook('test');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://admin.example.test/api/telegram/webhook');
    assert.equal(calls[0].options.drop_pending_updates, false);
    assert.deepEqual(calls[0].options.allowed_updates, ['message', 'callback_query']);
    assert.equal(getWebhookInfo().pending_update_count, 16);
});

test('validates the webhook secret with the derived token secret', () => {
    const { runtime } = createFixture();
    assert.equal(runtime.validateWebhookSecret(deriveWebhookSecret('123:test-token')), true);
    assert.equal(runtime.validateWebhookSecret('wrong'), false);
});

test('deduplicates Telegram retries in the running process', async () => {
    const { runtime, handled } = createFixture();
    assert.deepEqual(await runtime.handleUpdate({ update_id: 42 }), { duplicate: false });
    assert.deepEqual(await runtime.handleUpdate({ update_id: 42 }), { duplicate: true });
    assert.deepEqual(handled, [42]);
});

test('reports a healthy webhook after repair', async () => {
    const { runtime } = createFixture();
    await runtime.ensureWebhook('test');
    const status = await runtime.getStatus();

    assert.equal(status.healthy, true);
    assert.equal(status.username, 'yoko_park_bot');
    assert.equal(status.pendingUpdateCount, 16);
    assert.equal(status.repairRecommended, false);
});
