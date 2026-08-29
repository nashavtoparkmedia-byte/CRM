'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registrationPayload } = require('../services/botRegistryPayload');

test('registry payload preserves Telegram identity and verified phone evidence', () => {
    assert.deepEqual(registrationPayload({
        telegram_id: '123456',
        username: 'driver',
        first_name: 'Иван',
        last_name: 'Иванов',
        phone: '+79990000000',
        phone_verified: 1,
    }, false), {
        telegramId: '123456',
        username: 'driver',
        firstName: 'Иван',
        lastName: 'Иванов',
        phone: '+79990000000',
        phoneVerified: true,
        attemptAutoLink: false,
    });
});

test('registry payload does not invent phone ownership evidence', () => {
    const payload = registrationPayload({ telegramId: 123456 }, true);
    assert.equal(payload.telegramId, '123456');
    assert.equal(payload.phone, null);
    assert.equal(payload.phoneVerified, false);
    assert.equal(payload.attemptAutoLink, true);
});
