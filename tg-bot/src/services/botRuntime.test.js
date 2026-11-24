const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotRuntime, deriveWebhookSecret } = require('./botRuntime');

const silent = { info() {}, warn() {}, error() {} };
const TOKEN = '123456:AAHtesttokenvaluefortestsonly';

function runtime(env = {}) {
    return createBotRuntime({ env: { BOT_TOKEN: TOKEN, ...env }, logger: silent, botToken: TOKEN });
}

test('defaults to polling so an unconfigured host keeps its existing transport', () => {
    assert.equal(runtime().mode, 'polling');
    assert.equal(runtime({ BOT_UPDATE_MODE: 'WEBHOOK' }).mode, 'webhook');
});

test('the webhook secret is derived from the bot token and is stable', () => {
    const a = deriveWebhookSecret(TOKEN);
    assert.equal(a, deriveWebhookSecret(TOKEN));
    assert.notEqual(a, deriveWebhookSecret(`${TOKEN}x`));
    // Must be usable verbatim as a Telegram secret_token header value.
    assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('the derived secret never leaks the token', () => {
    assert.ok(!deriveWebhookSecret(TOKEN).includes(TOKEN));
    assert.ok(!deriveWebhookSecret(TOKEN).includes(TOKEN.split(':')[1]));
});

test('webhook secret validation accepts only the exact secret', () => {
    const r = runtime({ BOT_UPDATE_MODE: 'webhook' });
    const secret = deriveWebhookSecret(TOKEN);
    assert.equal(r.validateWebhookSecret(secret), true);
    assert.equal(r.validateWebhookSecret(`${secret}x`), false);
    assert.equal(r.validateWebhookSecret(secret.slice(0, -1)), false);
    assert.equal(r.validateWebhookSecret(secret.toUpperCase()), false);
});

test('webhook secret validation fails closed on missing input', () => {
    const r = runtime({ BOT_UPDATE_MODE: 'webhook' });
    for (const bad of [undefined, null, '', 0, false]) {
        assert.equal(r.validateWebhookSecret(bad), false);
    }
});

test('an explicitly configured secret overrides the derived one', () => {
    const explicit = 'unit-test-explicit-webhook-secret-value-0123456789';
    const r = runtime({ BOT_UPDATE_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: explicit });
    assert.equal(r.validateWebhookSecret(explicit), true);
    assert.equal(r.validateWebhookSecret(deriveWebhookSecret(TOKEN)), false);
});

test('webhook mode refuses a non-HTTPS webhook URL', async () => {
    const r = runtime({ BOT_UPDATE_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'http://insecure.example/hook' });
    r.attach({ telegram: {}, handleUpdate() {} });
    await assert.rejects(() => r.start(), /HTTPS/);
});

test('polling mode never performs webhook recovery', async () => {
    const r = runtime({ BOT_UPDATE_MODE: 'polling' });
    await assert.rejects(() => r.ensureWebhook('manual'), /not webhook/);
});

test('polling update guard coalesces concurrent and repeated update ids', async () => {
    const r = runtime({ BOT_UPDATE_MODE: 'polling' });
    const bot = {
        botInfo: { id: 1, username: 'test_bot' },
        handleUpdate: async () => {},
        telegram: {},
    };
    r.attach(bot);
    await r.ensureBotIdentity();
    let dispatches = 0;
    let releaseDispatch;
    const gate = new Promise((resolve) => { releaseDispatch = resolve; });
    const dispatch = async () => {
        dispatches += 1;
        await gate;
    };

    const first = r.handleUpdate({ update_id: 100 }, dispatch);
    const concurrent = r.handleUpdate({ update_id: 100 }, dispatch);
    releaseDispatch();
    await Promise.all([first, concurrent]);
    await r.handleUpdate({ update_id: 100 }, dispatch);

    assert.equal(dispatches, 1);
});

test('polling proves the Telegram bot identity before dispatching updates', async () => {
    const r = runtime({ BOT_UPDATE_MODE: 'polling' });
    const calls = [];
    const bot = {
        botInfo: null,
        handleUpdate: async () => {},
        launch: async () => {},
        telegram: {
            async getMe() {
                calls.push('getMe');
                return { id: 1, username: 'test_bot' };
            },
            async deleteWebhook(options) {
                calls.push(['deleteWebhook', options]);
            },
        },
    };
    r.attach(bot);

    await r.start();
    let dispatches = 0;
    await r.handleUpdate({ update_id: 101 }, async () => { dispatches += 1; });

    assert.deepEqual(calls, ['getMe', ['deleteWebhook', { drop_pending_updates: false }]]);
    assert.equal(r.identityEstablished(), true);
    assert.equal(dispatches, 1);
    r.stop();
});
