'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exactTelegramActionBinding } = require('../services/exactTelegramActionBinding');

test('driver actions carry the receiving bot account and configured connection', () => {
    assert.deepEqual(exactTelegramActionBinding(
        { botInfo: { id: 123 } },
        { CRM_TELEGRAM_CONNECTION_ID: ' bot-connection ' },
    ), {
        providerAccountId: '123',
        connectionId: 'bot-connection',
    });
});

test('driver actions keep missing live authority empty so CRM fails closed', () => {
    assert.deepEqual(exactTelegramActionBinding({}, { TELEGRAM_BOT_ACCOUNT_ID: 'configured-only' }), {
        providerAccountId: '',
        connectionId: '',
    });
});
