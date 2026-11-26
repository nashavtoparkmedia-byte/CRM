'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getRequiredBotToken } = require('./botToken');

test('accepts only token-shaped values without logging them', () => {
    assert.equal(getRequiredBotToken('123456789:synthetic_test_token_value_1234567890'), '123456789:synthetic_test_token_value_1234567890');
});

test('fails closed for missing or malformed token values', () => {
    for (const value of [undefined, '', 'placeholder', '123:short', '123456789:contains spaces 0123456789']) {
        assert.throws(() => getRequiredBotToken(value), { message: 'BOT_TOKEN_INVALID' });
    }
});
