'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    constantTimeSecretEqual,
    getRequiredBotCrmSecret,
    isAcceptableBotCrmSecret,
} = require('./botCrmSecret');

const VALID_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth';

test('accepts a sufficiently long configured secret and trims outer whitespace', () => {
    assert.equal(isAcceptableBotCrmSecret(VALID_SECRET), true);
    assert.equal(getRequiredBotCrmSecret(` ${VALID_SECRET} `), VALID_SECRET);
});

test('rejects missing, weak, placeholder, and repeated-character secrets', () => {
    for (const value of [undefined, null, '', 'secret', 'x'.repeat(31), 'replace-me'.padEnd(40, 'x'), 'x'.repeat(40)]) {
        assert.equal(isAcceptableBotCrmSecret(value), false);
        assert.throws(() => getRequiredBotCrmSecret(value), { message: 'BOT_CRM_SECRET_INVALID' });
    }
});

test('compares only nonempty matching secrets', () => {
    assert.equal(constantTimeSecretEqual(VALID_SECRET, VALID_SECRET), true);
    assert.equal(constantTimeSecretEqual('wrong', VALID_SECRET), false);
    assert.equal(constantTimeSecretEqual('', VALID_SECRET), false);
});
