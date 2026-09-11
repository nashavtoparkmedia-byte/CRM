const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCrmWebhookUrl, DEFAULT_WEBHOOK_PATH, FALLBACK_WEBHOOK_URL } = require('./crmWebhookUrl');

test('bare origin gains the canonical webhook path', () => {
    // This is the exact value deploy/docker-compose.production.yml sets.
    assert.equal(resolveCrmWebhookUrl('http://gravity-mvp:3002'), `http://gravity-mvp:3002${DEFAULT_WEBHOOK_PATH}`);
});

test('origin with a trailing slash gains the canonical webhook path', () => {
    assert.equal(resolveCrmWebhookUrl('http://gravity-mvp:3002/'), `http://gravity-mvp:3002${DEFAULT_WEBHOOK_PATH}`);
});

test('an explicitly configured path is preserved', () => {
    assert.equal(resolveCrmWebhookUrl('http://gravity-mvp:3002/custom/hook'), 'http://gravity-mvp:3002/custom/hook');
});

test('the canonical path is preserved verbatim', () => {
    const url = `http://gravity-mvp:3002${DEFAULT_WEBHOOK_PATH}`;
    assert.equal(resolveCrmWebhookUrl(url), url);
});

test('https origin keeps its scheme', () => {
    assert.equal(resolveCrmWebhookUrl('https://crm.example.org'), `https://crm.example.org${DEFAULT_WEBHOOK_PATH}`);
});

test('query string survives normalisation', () => {
    assert.equal(resolveCrmWebhookUrl('http://gravity-mvp:3002/?tenant=1'), `http://gravity-mvp:3002${DEFAULT_WEBHOOK_PATH}?tenant=1`);
});

test('unset, empty and blank configuration fall back', () => {
    for (const value of [undefined, null, '', '   ']) {
        assert.equal(resolveCrmWebhookUrl(value), FALLBACK_WEBHOOK_URL);
    }
});

test('an unparseable value falls back instead of throwing', () => {
    assert.equal(resolveCrmWebhookUrl('not a url'), FALLBACK_WEBHOOK_URL);
});
