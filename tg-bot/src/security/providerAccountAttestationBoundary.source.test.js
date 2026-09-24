'use strict';

/**
 * M2A2-TG2B boundary: the bot reports a provider principal and owns none of the
 * provider-account foundation. It must not reach a database, must not name the
 * owner-side writer, and must take identity only from a live getMe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = relative => readFileSync(resolve(root, relative), 'utf8');

const ATTESTATION = 'src/services/providerAccountAttestation.js';
const CALL_SITES = [
    'src/services/botRuntime.js',
    'src/services/exactCrmBotDelivery.js',
    'src/bot.js',
];

test('the attestation module never reaches a database or the owner-side writer', () => {
    const source = read(ATTESTATION);
    assert.doesNotMatch(source, /@prisma\/client|require\('\.\.\/database'\)|PrismaClient|prisma\./);
    assert.doesNotMatch(source, /TelegramAccount|TelegramTransportBinding|recordTelegramTransportAttestationV1/);
    assert.doesNotMatch(source, /telegram-account-writer|telegram-account-intake|provider-account\//);
});

test('no bot call site imports provider-account persistence', () => {
    for (const relative of CALL_SITES) {
        const source = read(relative);
        assert.doesNotMatch(source, /telegram-account-writer|telegram-account-intake/, relative);
        assert.doesNotMatch(source, /TelegramAccount\b|TelegramTransportBinding/, relative);
    }
});

test('provider identity may only come from a live getMe result', () => {
    const source = read(ATTESTATION);
    // The principal is read from the observation argument, never from configuration.
    assert.match(source, /function exactProviderUserId\(value\)/);
    assert.match(source, /exactProviderUserId\(me && me\.id\)/);
    assert.doesNotMatch(source, /providerUserId\s*=\s*[^;]*environment\./);
    assert.doesNotMatch(source, /BOT_TOKEN|botToken/);
});

test('the transport locator is configuration and never falls back to the principal', () => {
    const source = read(ATTESTATION);
    assert.match(source, /CRM_TELEGRAM_CONNECTION_ID \|\| environment\.TELEGRAM_CONNECTION_ID/);
    assert.match(source, /transportRef === providerUserId/);
    assert.doesNotMatch(source, /transportRef\s*=\s*providerUserId/);
    assert.doesNotMatch(source, /transportRef.*\?\?\s*providerUserId/);
});

test('the signing key is derived and the secret never enters the payload', () => {
    const source = read(ATTESTATION);
    assert.match(source, /createHash\('sha256'\)\.update\(`\$\{DOMAIN_V1\}\|\$\{secret\}`\)/);
    assert.match(source, /createHmac\('sha256', deriveProviderAttestationKeyV1\(secret\)\)/);
    assert.match(source, /digest\('base64url'\)/);
    const payloadBlock = source.split('const payload = {', 2)[1].split('};', 1)[0];
    assert.doesNotMatch(payloadBlock, /secret|BOT_CRM_SECRET|key/i);
});

test('the attestation module never logs the secret or the derived key', () => {
    const source = read(ATTESTATION);
    for (const line of source.split('\n').filter(entry => /log\.(warn|info|error)/.test(entry))) {
        assert.doesNotMatch(line, /secret|derive|signature|key/i, line.trim());
    }
});

test('reporting is fire-and-forget at every call site', () => {
    const attestation = read(ATTESTATION);
    assert.match(attestation, /void runtime\.observe\(me, reason\)\.catch\(/);
    for (const relative of CALL_SITES) {
        const source = read(relative);
        assert.doesNotMatch(source, /await observe(BotPrincipalV1|ProviderPrincipal)\(/, relative);
    }
});
