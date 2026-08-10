'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const adminAuth = require('../middleware/auth');
const { isAcceptableWebhookSecret, requireTelegramWebhookSecret } = require('./webhookAuth');
const { redactText, sanitizeLogValue } = require('./redactSecrets');
const serverAuth = require('../../tg-bot-frontend/lib/serverAuth');

const root = resolve(__dirname, '../..');
const read = relative => readFileSync(resolve(root, relative), 'utf8');

function withAuthEnvironment(callback) {
    const previous = {
        ADMIN_USER: process.env.ADMIN_USER,
        ADMIN_PASS: process.env.ADMIN_PASS,
        ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
        BOT_TOKEN: process.env.BOT_TOKEN,
    };
    process.env.ADMIN_USER = 'operator';
    process.env.ADMIN_PASS = 'correct horse battery staple';
    process.env.ADMIN_SESSION_SECRET = 'independent-session-signing-secret';
    process.env.BOT_TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz_ABCDE';
    try {
        return callback();
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

function responseRecorder() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test('admin middleware rejects missing configuration, query credentials and invalid Basic auth', () => {
    const previousUser = process.env.ADMIN_USER;
    const previousPass = process.env.ADMIN_PASS;
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASS;
    try {
        const unconfigured = responseRecorder();
        adminAuth({ headers: {}, query: {} }, unconfigured, () => assert.fail('must fail closed'));
        assert.equal(unconfigured.statusCode, 503);
    } finally {
        if (previousUser === undefined) delete process.env.ADMIN_USER;
        else process.env.ADMIN_USER = previousUser;
        if (previousPass === undefined) delete process.env.ADMIN_PASS;
        else process.env.ADMIN_PASS = previousPass;
    }

    const weakPreviousUser = process.env.ADMIN_USER;
    const weakPreviousPass = process.env.ADMIN_PASS;
    process.env.ADMIN_USER = 'admin';
    process.env.ADMIN_PASS = 'admin123';
    try {
        const weakConfigured = responseRecorder();
        adminAuth({ headers: {}, query: {} }, weakConfigured, () => assert.fail('weak configured password must fail closed'));
        assert.equal(weakConfigured.statusCode, 503);
    } finally {
        if (weakPreviousUser === undefined) delete process.env.ADMIN_USER;
        else process.env.ADMIN_USER = weakPreviousUser;
        if (weakPreviousPass === undefined) delete process.env.ADMIN_PASS;
        else process.env.ADMIN_PASS = weakPreviousPass;
    }

    withAuthEnvironment(() => {
        const queryAttempt = responseRecorder();
        adminAuth({ headers: {}, query: { token: Buffer.from('operator:correct horse battery staple').toString('base64') } }, queryAttempt, () => assert.fail('query auth must be rejected'));
        assert.equal(queryAttempt.statusCode, 401);

        const invalid = responseRecorder();
        adminAuth({ headers: { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` }, query: {} }, invalid, () => assert.fail('invalid auth must be rejected'));
        assert.equal(invalid.statusCode, 401);
    });
});

test('admin middleware accepts only configured Basic credentials', () => withAuthEnvironment(() => {
    let nextCalled = false;
    const res = responseRecorder();
    const authorization = `Basic ${Buffer.from('operator:correct horse battery staple').toString('base64')}`;
    adminAuth({ headers: { authorization }, query: {} }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
}));

test('frontend authentication rejects weak and placeholder configured passwords', () => {
    const previousUser = process.env.ADMIN_USER;
    const previousPass = process.env.ADMIN_PASS;
    process.env.ADMIN_USER = 'admin';
    try {
        for (const password of ['admin123', 'password', 'changeme', '__GENERATE_WITH_openssl_rand_base64_24__', 'replace-me-now']) {
            process.env.ADMIN_PASS = password;
            assert.equal(serverAuth.configuredCredentials(), null);
            assert.equal(serverAuth.authenticateCredentials('admin', password), false);
            assert.equal(serverAuth.createSessionToken(), null);
        }
    } finally {
        if (previousUser === undefined) delete process.env.ADMIN_USER;
        else process.env.ADMIN_USER = previousUser;
        if (previousPass === undefined) delete process.env.ADMIN_PASS;
        else process.env.ADMIN_PASS = previousPass;
    }
});

test('frontend fails closed on a weak explicit session-signing secret', () => withAuthEnvironment(() => {
    for (const secret of ['short', 'replace-me-before-production', '__GENERATE_SESSION_SECRET__']) {
        process.env.ADMIN_SESSION_SECRET = secret;
        assert.equal(serverAuth.isAcceptableSessionSecret(secret), false);
        assert.equal(serverAuth.createSessionToken(), null);
    }
}));

test('HttpOnly session tokens reject tampering and expiry', () => withAuthEnvironment(() => {
    const now = Date.parse('2026-08-10T12:00:00Z');
    const token = serverAuth.createSessionToken(now);
    assert.equal(serverAuth.verifySessionToken(token, now), true);
    assert.equal(serverAuth.verifySessionToken(`${token}tampered`, now), false);
    assert.equal(serverAuth.verifySessionToken(token, now + (serverAuth.SESSION_TTL_SECONDS + 1) * 1000), false);

    const cookie = serverAuth.sessionCookie(token);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /correct horse battery staple/);
    assert.equal(serverAuth.requestHasValidSession({ headers: { cookie } }, now), true);
}));

test('central log sanitizer removes Telegram credentials from strings and objects', () => withAuthEnvironment(() => {
    const token = process.env.BOT_TOKEN;
    assert.equal(redactText(`request https://api.telegram.org/bot${token}/getMe`).includes(token), false);
    const basic = `Basic ${Buffer.from('operator:correct horse battery staple').toString('base64')}`;
    assert.equal(redactText(`authorization=${basic}`).includes(basic), false);
    const sanitized = sanitizeLogValue({
        botToken: token,
        authorization: basic,
        password: 'telegram-2fa-value',
        apiHash: 'telegram-application-secret',
        sessionString: 'telegram-session-material',
        nested: { message: `bad ${token}` },
    });
    assert.equal(JSON.stringify(sanitized).includes(token), false);
    assert.equal(sanitized.botToken, '[REDACTED]');
    assert.equal(sanitized.authorization, '[REDACTED]');
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.apiHash, '[REDACTED]');
    assert.equal(sanitized.sessionString, '[REDACTED]');
    const interceptorSource = read('src/utils/log-interceptor.js');
    for (const level of ['error', 'log', 'warn', 'info', 'debug']) {
        assert.match(interceptorSource, new RegExp(`['\"]${level}['\"]`));
    }
    assert.match(interceptorSource, /mode: 0o600/);
}));

test('webhook authentication fails closed for missing and invalid secret headers', () => {
    const previous = process.env.TELEGRAM_WEBHOOK_SECRET;
    const request = value => ({ get: () => value });
    try {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
        const unconfigured = responseRecorder();
        requireTelegramWebhookSecret(request(undefined), unconfigured, () => assert.fail('must fail closed'));
        assert.equal(unconfigured.statusCode, 503);

        for (const weakSecret of ['short', 'replace-me-webhook-secret', '__GENERATE_WEBHOOK_SECRET__']) {
            process.env.TELEGRAM_WEBHOOK_SECRET = weakSecret;
            assert.equal(isAcceptableWebhookSecret(weakSecret), false);
            const weak = responseRecorder();
            requireTelegramWebhookSecret(request(weakSecret), weak, () => assert.fail('weak secret must fail closed'));
            assert.equal(weak.statusCode, 503);
        }

        process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-delivery-secret';
        const invalid = responseRecorder();
        requireTelegramWebhookSecret(request('wrong'), invalid, () => assert.fail('invalid secret must fail'));
        assert.equal(invalid.statusCode, 401);

        let nextCalled = false;
        requireTelegramWebhookSecret(request('telegram-delivery-secret'), responseRecorder(), () => { nextCalled = true; });
        assert.equal(nextCalled, true);
    } finally {
        if (previous === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
        else process.env.TELEGRAM_WEBHOOK_SECRET = previous;
    }
});

test('sources contain no default/query/browser-persisted admin credential lanes', () => {
    const backendAuth = read('src/middleware/auth.js');
    const browserAuth = [
        read('tg-bot-frontend/context/AuthContext.js'),
        read('tg-bot-frontend/lib/api.js'),
        read('tg-bot-frontend/pages/surveys/[id].js'),
    ].join('\n');
    const proxy = read('tg-bot-frontend/pages/api/admin/[...path].js');
    const nextConfig = read('tg-bot-frontend/next.config.mjs');

    assert.doesNotMatch(backendAuth, /req\.query\.token|query credentials|ADMIN_PASS\s*\|\||validPassword\s*\|\|/i);
    assert.match(backendAuth, /\['admin123', 'password', 'changeme'\]\.includes\(normalized\)/);
    assert.doesNotMatch(browserAuth, /crm_token|#auth=|Authorization.*Basic|localStorage\.getItem\([^)]*token/i);
    assert.match(proxy, /requestHasValidSession/);
    assert.match(proxy, /configuredCredentials/);
    assert.match(proxy, /name !== 'token'/);
    assert.doesNotMatch(nextConfig, /rewrites|TG_BOT_API_URL/);
});

test('webhook source defaults to an authenticated token-free URL', () => {
    const source = read('src/routes/webhooks.js');
    const authSource = read('src/security/webhookAuth.js');
    assert.match(source, /router\.post\('\/telegram\/:botId', requireTelegramWebhookSecret/);
    assert.match(authSource, /x-telegram-bot-api-secret-token/);
    assert.match(source, /ALLOW_LEGACY_WEBHOOK_PATH !== 'true'/);
    assert.doesNotMatch(source, /substring\(|slice\(|mapping.*token:/i);
});

test('known bot-token diagnostics and runtime paths never log token values or prefixes', () => {
    const sources = [
        'src/bot.js',
        'src/handlers/start.js',
        'src/handlers/dynamicSurvey.js',
        'src/routes/webhooks.js',
        'test-prisma-query.js',
        'check-prisma.js',
        'check-bot-token.js',
        '../gravity-mvp/scripts/backfill_tg_via_bot_api.js',
    ].map(read).join('\n');

    assert.doesNotMatch(sources, /(?:console|logger)\.(?:log|info|warn|error|debug)\([^\n]*(?:\$\{\s*(?:botToken|token)\b|,\s*(?:botToken|token)\s*\))/);
    assert.doesNotMatch(sources, /(?:botToken|token)\.(?:substring|substr|slice)\(/);
    assert.doesNotMatch(read('src/bot.js'), /logger\.(?:info|error)\([^\n]*\$\{socksUrl\}/);
});
