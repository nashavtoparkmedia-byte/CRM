'use strict';

/**
 * CRM -> Telegram Bot delivery contract.
 *
 * Two defects motivate the shape pinned here, both proven against production on
 * 2026-09-30 by one controlled send that was refused before any Telegram call.
 *
 * The handler used to require `providerAccountId` on the request. No production
 * Telegram conversation carries a provider-account stamp (0 of 219), so
 * `outbound.providerAccountId` is always null and Gravity omits the field — which
 * meant every CRM delivery was rejected with
 * TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN while proving nothing. The field is now
 * optional, and is still held to the proven live identity whenever it IS supplied.
 *
 * The handler also called `getMe` immediately before every send, so each outbound
 * delivery depended on a fresh api.telegram.org round trip over an egress that
 * intermittently resets. It now reuses the readiness-proven identity that
 * botRuntime.ensureBotIdentity() assigns to Telegraf's botInfo, and never
 * re-fetches it per delivery.
 *
 * The connection binding stays mandatory and canonical, authentication stays
 * mandatory, and nothing here can route through MTProto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExactCrmBotDeliveryHandler } = require('../services/exactCrmBotDelivery');

const LIVE_ACCOUNT = 123;

function responseRecorder() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function request(body, signature = 'shared-secret') {
    return { body, get: name => name === 'x-bot-signature' ? signature : undefined };
}

const PROVEN_IDENTITY = { id: LIVE_ACCOUNT, username: 'yoko_bot' };

// `opts.botInfo` is read with `in` rather than a destructuring default, because a
// destructuring default fires on an explicit `undefined` and would silently
// restore the identity in exactly the fail-closed cases under test.
function fixture(overrides = {}, opts = {}) {
    const botInfo = 'botInfo' in opts ? opts.botInfo : PROVEN_IDENTITY;
    const calls = [];
    const bot = {
        // Readiness-proven identity, exactly as botRuntime assigns it.
        botInfo,
        telegram: {
            // Present on purpose: the tests assert it is NEVER called per delivery.
            getMe: async () => { calls.push('getMe'); return { id: LIVE_ACCOUNT, username: 'yoko_bot' }; },
            sendMessage: async (...args) => { calls.push(['sendMessage', ...args]); return { message_id: 9001 }; },
        },
    };
    const logger = { info() {}, error() {} };
    const environment = {
        BOT_CRM_SECRET: 'shared-secret',
        CRM_TELEGRAM_CONNECTION_ID: 'bot-connection',
    };
    return {
        calls,
        bot,
        handler: createExactCrmBotDeliveryHandler({ bot, logger, environment: { ...environment, ...overrides } }),
    };
}

function sendCalls(calls) {
    return calls.filter(call => Array.isArray(call) && call[0] === 'sendMessage');
}

// ── the repair: an omitted provider account must not reject delivery ─────────

test('delivers when providerAccountId is omitted, echoing the proven live account', async () => {
    const { calls, handler } = fixture();
    const response = responseRecorder();
    await handler(request({
        chatId: '42',
        text: 'hello',
        connectionId: 'bot-connection',
    }), response);

    assert.equal(response.statusCode, 200, 'absence alone must not reject delivery');
    assert.deepEqual(response.body, {
        success: true,
        messageId: '9001',
        providerAccountId: '123',
        connectionId: 'bot-connection',
    }, 'returns the live Bot account, the actual connection and the provider message id');
    assert.equal(sendCalls(calls).length, 1, 'exactly one provider mutation');
});

test('delivers when providerAccountId is supplied and matches the proven live account', async () => {
    const { calls, handler } = fixture();
    const response = responseRecorder();
    await handler(request({
        chatId: '42',
        text: 'hello',
        providerAccountId: '123',
        connectionId: 'bot-connection',
    }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.providerAccountId, '123');
    assert.equal(sendCalls(calls).length, 1);
});

test('rejects a supplied providerAccountId that contradicts the proven live account', async () => {
    const { calls, handler } = fixture();
    const response = responseRecorder();
    await handler(request({
        chatId: '42',
        text: 'hello',
        providerAccountId: '999',
        connectionId: 'bot-connection',
    }), response);

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error, 'TELEGRAM_BOT_PROVIDER_ACCOUNT_MISMATCH');
    assert.deepEqual(sendCalls(calls), [], 'zero send mutation on a contradicted account');
});

// ── the repair: no lazy getMe per outbound delivery ─────────────────────────

test('never calls getMe per delivery — the readiness-proven identity is reused', async () => {
    const { calls, handler } = fixture();
    for (const text of ['one', 'two', 'three']) {
        const response = responseRecorder();
        await handler(request({ chatId: '42', text, connectionId: 'bot-connection' }), response);
        assert.equal(response.statusCode, 200);
    }
    assert.equal(calls.filter(call => call === 'getMe').length, 0,
        'a flaky egress must not be able to break outbound delivery');
    assert.equal(sendCalls(calls).length, 3);
});

test('fails closed when no readiness-proven identity exists, with zero send mutation', async () => {
    for (const botInfo of [undefined, null, {}, { username: 'no_id' }]) {
        const { calls, handler } = fixture({}, { botInfo });
        const response = responseRecorder();
        await handler(request({ chatId: '42', text: 'hello', connectionId: 'bot-connection' }), response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.error, 'TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN');
        assert.deepEqual(sendCalls(calls), []);
        assert.equal(calls.filter(call => call === 'getMe').length, 0,
            'an unproven identity is never repaired by a lazy getMe here');
    }
});

test('never substitutes configuration for the proven provider account', async () => {
    // A configured account id must not stand in for the live identity.
    const { calls, handler } = fixture(
        { TELEGRAM_BOT_PROVIDER_ACCOUNT_ID: '123', BOT_PROVIDER_ACCOUNT_ID: '123' },
        { botInfo: undefined },
    );
    const response = responseRecorder();
    await handler(request({ chatId: '42', text: 'hello', connectionId: 'bot-connection' }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, 'TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN');
    assert.deepEqual(sendCalls(calls), []);
});

// ── unchanged contract: peer, text, auth, canonical connection, keyboard ────

test('delivers to the exact peer with the exact text and echoes the proof', async () => {
    const { calls, handler } = fixture();
    const response = responseRecorder();
    const inlineKeyboard = [[{ text: 'Choose', callback_data: 'choice' }]];
    await handler(request({
        chatId: '42',
        text: 'hello',
        providerAccountId: '123',
        connectionId: 'bot-connection',
        inlineKeyboard,
    }), response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        success: true,
        messageId: '9001',
        providerAccountId: '123',
        connectionId: 'bot-connection',
    });
    assert.deepEqual(calls, [
        ['sendMessage', '42', 'hello', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        }],
    ], 'one send, no getMe');
});

test('rejects missing auth and wrong connection with zero send mutation', async () => {
    for (const scenario of [
        { signature: null, account: '123', connection: 'bot-connection', status: 401 },
        { signature: 'shared-secret', account: '999', connection: 'bot-connection', status: 409 },
        { signature: 'shared-secret', account: '123', connection: 'other-connection', status: 409 },
    ]) {
        const { calls, handler } = fixture();
        const response = responseRecorder();
        await handler(request({
            chatId: '42',
            text: 'hello',
            providerAccountId: scenario.account,
            connectionId: scenario.connection,
        }, scenario.signature), response);
        assert.equal(response.statusCode, scenario.status);
        assert.deepEqual(sendCalls(calls), []);
    }
});

test('connection binding stays mandatory and canonical', async () => {
    // Note the asymmetry with Gravity's own concreteId, which refuses an
    // untrimmed value outright: this handler normalises by trimming, so
    // '  bot-connection  ' resolves to the canonical id and is accepted. Gravity
    // only ever sends the canonical trimmed value, so nothing live depends on it.
    // Left as-is deliberately — narrowing it is outside this repair.
    for (const scenario of [
        { connectionId: undefined, status: 400 },
        { connectionId: '', status: 400 },
        { connectionId: 'legacy', status: 400 },
        { connectionId: 'telegram-default', status: 400 },
    ]) {
        const { calls, handler } = fixture();
        const response = responseRecorder();
        await handler(request({
            chatId: '42',
            text: 'hello',
            connectionId: scenario.connectionId,
        }), response);
        assert.equal(response.statusCode, scenario.status,
            `connectionId ${JSON.stringify(scenario.connectionId)} must be refused`);
        assert.deepEqual(sendCalls(calls), []);
    }
});

test('refuses an unset live connection even when the caller supplies one', async () => {
    const { calls, handler } = fixture({ CRM_TELEGRAM_CONNECTION_ID: '' });
    const response = responseRecorder();
    await handler(request({ chatId: '42', text: 'hello', connectionId: 'bot-connection' }), response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, 'TELEGRAM_BOT_CONNECTION_UNPROVEN');
    assert.deepEqual(sendCalls(calls), []);
});

test('rejects an invalid peer and empty text before any provider call', async () => {
    for (const body of [
        { chatId: '0', text: 'hello', connectionId: 'bot-connection' },
        { chatId: 'abc', text: 'hello', connectionId: 'bot-connection' },
        { chatId: undefined, text: 'hello', connectionId: 'bot-connection' },
        { chatId: '42', text: '', connectionId: 'bot-connection' },
        { chatId: '42', text: undefined, connectionId: 'bot-connection' },
    ]) {
        const { calls, handler } = fixture();
        const response = responseRecorder();
        await handler(request(body), response);
        assert.equal(response.statusCode, 400);
        assert.deepEqual(calls, []);
    }
});

test('rejects malformed keyboards before live provider calls', async () => {
    const { calls, handler } = fixture();
    const response = responseRecorder();
    await handler(request({
        chatId: '42',
        text: 'hello',
        providerAccountId: '123',
        connectionId: 'bot-connection',
        inlineKeyboard: [[{ text: 'ambiguous', callback_data: 'a', url: 'https://example.test' }]],
    }), response);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(calls, []);
});

test('rejects an unproven provider message id rather than reporting false success', async () => {
    for (const messageId of [0, '', null, 'abc']) {
        const { handler } = fixture({}, { botInfo: { id: LIVE_ACCOUNT, username: 'yoko_bot' } });
        const response = responseRecorder();
        await handler(request({ chatId: '42', text: 'hello', connectionId: 'bot-connection' }), response);
        // fixture() always resolves a valid message_id, so drive the unproven
        // case through a handler whose sendMessage returns this value.
        const unprovenResponse = responseRecorder();
        const unprovenHandler = createExactCrmBotDeliveryHandler({
            bot: {
                botInfo: { id: LIVE_ACCOUNT, username: 'yoko_bot' },
                telegram: { sendMessage: async () => ({ message_id: messageId }) },
            },
            logger: { info() {}, error() {} },
            environment: { BOT_CRM_SECRET: 'shared-secret', CRM_TELEGRAM_CONNECTION_ID: 'bot-connection' },
        });
        await unprovenHandler(
            request({ chatId: '42', text: 'hello', connectionId: 'bot-connection' }),
            unprovenResponse,
        );
        assert.equal(response.statusCode, 200, 'control: a proven id still succeeds');
        assert.equal(unprovenResponse.statusCode, 400);
        assert.equal(unprovenResponse.body.error, 'TELEGRAM_BOT_DELIVERY_RESULT_UNPROVEN');
    }
});
