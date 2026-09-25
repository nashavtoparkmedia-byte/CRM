'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    canonicalProviderAttestationV1,
    createProviderAccountAttestationV1,
    deriveProviderAttestationKeyV1,
    signProviderAttestationV1,
} = require('./providerAccountAttestation');

const SECRET = 'test-bot-secret';
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ATTESTATION = '22222222-2222-4222-8222-222222222222';

/**
 * Known answer shared with the Gravity implementation. If either side changes
 * its canonical form or key derivation, exactly one of the two suites fails.
 */
const KNOWN_CANONICAL = [
    'yoko-telegram-provider-attestation:v1',
    'attest_provider_account',
    '7000',
    'driver-bot-primary',
    INSTANCE,
    '1790000000000',
    ATTESTATION,
].join('\n');
const KNOWN_SIGNATURE = 'RKgV0cfeg_6MEm0JQAYePsDndC7OJpMuig38fswVr-s';

function environment(overrides = {}) {
    return {
        BOT_CRM_SECRET: SECRET,
        CRM_TELEGRAM_CONNECTION_ID: 'driver-bot-primary',
        CRM_WEBHOOK_URL: 'http://gravity-mvp:3002',
        ...overrides,
    };
}

function harness(overrides = {}, envOverrides = {}) {
    const posted = [];
    const warnings = [];
    let uuidCount = 0;
    const attestation = createProviderAccountAttestationV1({
        env: environment(envOverrides),
        now: () => 1790000000000,
        randomUUID: () => (uuidCount++ === 0 ? INSTANCE : `${ATTESTATION.slice(0, 35)}${uuidCount}`),
        post: async (url, body, secret) => { posted.push({ url, body, secret }); return { ok: true, status: 200 }; },
        logger: { warn: message => warnings.push(message), info: () => {}, error: () => {} },
        minIntervalMs: 0,
        ...overrides,
    });
    return { attestation, posted, warnings };
}

test('the canonical statement and signature match the shared known answer', () => {
    const canonical = canonicalProviderAttestationV1({
        providerUserId: '7000',
        transportRef: 'driver-bot-primary',
        attestingInstanceId: INSTANCE,
        observedAt: 1790000000000,
        attestationId: ATTESTATION,
    });
    assert.equal(canonical, KNOWN_CANONICAL);
    assert.equal(signProviderAttestationV1(canonical, SECRET), KNOWN_SIGNATURE);
    assert.equal(deriveProviderAttestationKeyV1(SECRET).length, 32);
    assert.notEqual(deriveProviderAttestationKeyV1(SECRET).toString('base64url'), SECRET);
});

test('the provider principal comes from the live getMe result', async () => {
    const { attestation, posted } = harness();
    await attestation.observe({ id: 7000, username: 'driver_bot' }, 'test');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.action, 'attest_provider_account');
    assert.equal(posted[0].body.payload.providerUserId, '7000');
});

test('the runtime instance id is minted once and reused by every observation', async () => {
    const { attestation, posted } = harness();
    await attestation.observe({ id: 7000 }, 'one');
    await attestation.observe({ id: 7000 }, 'two');
    assert.equal(posted.length, 2);
    assert.equal(posted[0].body.payload.attestingInstanceId, INSTANCE);
    assert.equal(posted[1].body.payload.attestingInstanceId, INSTANCE);
    assert.equal(attestation.attestingInstanceId, INSTANCE);
});

test('every observation carries a fresh attestation id and an observation time', async () => {
    const { attestation, posted } = harness();
    await attestation.observe({ id: 7000 }, 'one');
    await attestation.observe({ id: 7000 }, 'two');
    assert.notEqual(posted[0].body.payload.attestationId, posted[1].body.payload.attestationId);
    for (const entry of posted) {
        assert.equal(entry.body.payload.observedAt, 1790000000000);
    }
});

test('the transport locator comes from configuration and is never the principal', async () => {
    const { attestation, posted } = harness();
    await attestation.observe({ id: 7000 }, 'test');
    assert.equal(posted[0].body.payload.transportRef, 'driver-bot-primary');
    assert.notEqual(posted[0].body.payload.transportRef, posted[0].body.payload.providerUserId);
});

test('an unconfigured transport locator is refused instead of falling back to the principal', async () => {
    const { attestation, posted, warnings } = harness({}, { CRM_TELEGRAM_CONNECTION_ID: '', TELEGRAM_CONNECTION_ID: '' });
    const result = await attestation.observe({ id: 7000 }, 'test');
    assert.deepEqual(result, { sent: false, reason: 'transport_ref_unconfigured' });
    assert.equal(posted.length, 0);
    assert.equal(warnings.length, 1);
});

test('a transport locator equal to the principal is refused', async () => {
    const { attestation, posted } = harness({}, { CRM_TELEGRAM_CONNECTION_ID: '7000' });
    const result = await attestation.observe({ id: 7000 }, 'test');
    assert.deepEqual(result, { sent: false, reason: 'transport_ref_is_principal' });
    assert.equal(posted.length, 0);
});

test('an unusable principal is refused', async () => {
    const { attestation, posted } = harness();
    for (const id of [undefined, null, 0, '0', 'abc', '+7000', '']) {
        const result = await attestation.observe({ id }, 'test');
        assert.deepEqual(result, { sent: false, reason: 'principal_unproven' });
    }
    assert.equal(posted.length, 0);
});

test('the posted statement is signed over its own canonical form', async () => {
    const { attestation, posted } = harness();
    await attestation.observe({ id: 7000 }, 'test');
    const payload = posted[0].body.payload;
    const canonical = canonicalProviderAttestationV1(payload);
    assert.equal(payload.signature, signProviderAttestationV1(canonical, SECRET));
});

test('the shared secret never travels inside the payload and is never logged', async () => {
    const { attestation, posted, warnings } = harness();
    await attestation.observe({ id: 7000 }, 'test');
    const serialized = JSON.stringify(posted[0].body);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes(deriveProviderAttestationKeyV1(SECRET).toString('base64url')), false);
    assert.equal(warnings.join('|').includes(SECRET), false);
    // The bearer header still carries the secret: that is the existing boundary.
    assert.equal(posted[0].secret, SECRET);
});

test('observations are rate limited inside one process', async () => {
    let clock = 1790000000000;
    const { attestation, posted } = harness({ now: () => clock, minIntervalMs: 600000 });
    await attestation.observe({ id: 7000 }, 'first');
    clock += 60000;
    const skipped = await attestation.observe({ id: 7000 }, 'second');
    assert.deepEqual(skipped, { sent: false, reason: 'rate_limited' });
    clock += 600000;
    await attestation.observe({ id: 7000 }, 'third');
    assert.equal(posted.length, 2);
});

test('a failing transport never throws into the caller and is not retried', async () => {
    const { attestation, warnings } = harness({
        post: async () => { throw new Error('connection refused'); },
    });
    const result = await attestation.observe({ id: 7000 }, 'test');
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'observation_failed');
    assert.equal(warnings.length, 1);
});

test('a CRM rejection is reported once and dropped', async () => {
    const { attestation, warnings } = harness({ post: async () => ({ ok: false, status: 409 }) });
    const result = await attestation.observe({ id: 7000 }, 'test');
    assert.deepEqual(result, { sent: true, ok: false, status: 409 });
    assert.equal(warnings.length, 1);
});

test('the report targets the existing authenticated CRM action endpoint', async () => {
    const { attestation, posted } = harness();
    await attestation.observe({ id: 7000 }, 'test');
    assert.equal(posted[0].url, 'http://gravity-mvp:3002/api/webhooks/bot');
});
