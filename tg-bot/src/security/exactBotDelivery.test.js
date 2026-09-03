'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExactCrmBotDeliveryHandler } = require('../services/exactCrmBotDelivery');

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

function fixture(overrides = {}) {
    const calls = [];
    const bot = {
        telegram: {
            getMe: async () => { calls.push('getMe'); return { id: 123 }; },
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

test('attests live Bot API account immediately before exact peer delivery and echoes proof', async () => {
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
        'getMe',
        ['sendMessage', '42', 'hello', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        }],
    ]);
});

test('rejects missing auth, wrong live account, and wrong connection with zero send mutation', async () => {
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
        assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'sendMessage'), false);
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
