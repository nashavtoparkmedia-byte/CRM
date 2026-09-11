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
    const explicit = 'explicit-secret-value-0123456789';
    const r = runtime({ BOT_UPDATE_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: explicit });
    assert.equal(r.validateWebhookSecret(explicit), true);
    assert.equal(r.validateWebhookSecret(deriveWebhookSecret(TOKEN)), false);
});

test('webhook mode refuses a non-HTTPS webhook URL', async () => {
    const r = runtime({ BOT_UPDATE_MODE: 'webhook', TELEGRAM_WEBHOOK_URL: 'http://insecure.example/hook' });
    r.attach({ telegram: {} });
    await assert.rejects(() => r.start(), /HTTPS/);
});

test('polling mode never performs webhook recovery', async () => {
    const r = runtime({ BOT_UPDATE_MODE: 'polling' });
    await assert.rejects(() => r.ensureWebhook('manual'), /not webhook/);
});
