'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { google } = require('googleapis');
const { googleServiceAccountOptions } = require('./googleServiceAccount');
const sheetsService = require('./sheets');
const logger = require('../utils/logger');

test('parses inline service-account JSON without treating it as a filename', () => {
    const credentials = {
        type: 'service_account',
        client_email: 'p0-test@example.invalid',
        private_key: 'synthetic test value',
    };
    assert.deepEqual(
        googleServiceAccountOptions(JSON.stringify(credentials), '/app'),
        { credentials },
    );
});

test('Google SDK accepts parsed service-account JSON without an API request', async () => {
    const email = 'p0-test@example.invalid';
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
        .export({ type: 'pkcs8', format: 'pem' });
    const auth = new google.auth.GoogleAuth({
        ...googleServiceAccountOptions(JSON.stringify({
            type: 'service_account',
            client_email: email,
            private_key: privateKey,
        }), '/app'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    assert.equal(client.email, email);
    assert.equal(client.key, privateKey);
});

test('bot Sheets startup initialization does not require service-account credentials', async () => {
    const original = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    try {
        await assert.doesNotReject(() => sheetsService.initializeSheet());
    } finally {
        if (original === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        else process.env.GOOGLE_SERVICE_ACCOUNT_KEY = original;
    }
});

test('supports a protected credential file path and the legacy default path', () => {
    assert.deepEqual(googleServiceAccountOptions('/run/secrets/google.json', '/app'), {
        keyFile: '/run/secrets/google.json',
    });
    assert.deepEqual(googleServiceAccountOptions('', '/app'), {
        keyFile: path.resolve('/app', 'service-account.json'),
    });
});

test('rejects malformed credentials with stable errors that contain no input text', () => {
    const malformed = '{"type":"service_account","private_key":"synthetic-secret-marker"';
    assert.throws(
        () => googleServiceAccountOptions(malformed, '/app'),
        (error) => error.message === 'GOOGLE_SERVICE_ACCOUNT_KEY_INVALID_JSON'
            && !error.message.includes('synthetic-secret-marker'),
    );
    assert.throws(
        () => googleServiceAccountOptions('{"type":"user"}', '/app'),
        { message: 'GOOGLE_SERVICE_ACCOUNT_KEY_INVALID' },
    );
});

test('Google credential parse failures never write credential input to logs', async () => {
    const secretMarker = 'synthetic-google-private-key-marker';
    const previous = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const originalError = logger.error;
    const entries = [];
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = `{"type":"service_account","private_key":"${secretMarker}"`;
    logger.error = (...args) => entries.push(args);
    const sheetsPath = require.resolve('./sheets');
    delete require.cache[sheetsPath];
    try {
        await require('./sheets').upsertUserRow(123, 'synthetic-user', {});
        assert.ok(entries.length > 0);
        assert.ok(!JSON.stringify(entries).includes(secretMarker));
        assert.ok(entries.every((entry) => entry.length === 1), 'raw Error objects are not logged');
    } finally {
        delete require.cache[sheetsPath];
        logger.error = originalError;
        if (previous === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        else process.env.GOOGLE_SERVICE_ACCOUNT_KEY = previous;
    }
});
