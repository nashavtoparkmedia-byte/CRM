'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    FORBIDDEN_PUBLIC_CREDENTIAL_KEYS,
    assertNoPublicCredentialKeys,
    projectBotMetadata,
} = require('./publicCredentialMetadata');

test('Bot public metadata omits the token and retains configured status', () => {
    const source = {
        id: 'bot-1',
        name: 'Survey bot',
        username: '@survey',
        isActive: true,
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
        token: '123456:raw-telegram-secret',
        surveys: [],
        _count: { users: 4 },
    };
    const dto = projectBotMetadata(source, true);

    assert.equal(dto.tokenConfigured, true);
    assert.equal(Object.hasOwn(dto, 'token'), false);
    assert.equal(JSON.stringify(dto).includes(source.token), false);
    assert.doesNotThrow(() => assertNoPublicCredentialKeys(dto));
});

test('Bot boundary guard rejects every known credential key recursively', () => {
    for (const key of FORBIDDEN_PUBLIC_CREDENTIAL_KEYS) {
        assert.throws(
            () => assertNoPublicCredentialKeys({ relation: [{ [key]: 'secret' }] }),
            new RegExp(`relation\\[0\\]\\.${key}$`),
        );
    }
});
