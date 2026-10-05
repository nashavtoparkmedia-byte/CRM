'use strict';

/**
 * Manager order-failure diagnostics, preserved from production behaviour.
 *
 * Admin ids are synthetic throughout and never read from the environment of the
 * machine running the tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
    diagnosticAdminIds,
    notifyManagerAboutFailure,
    shouldNotifyManagerAboutFailure,
    stoppedBeforeFleet,
} = require('../utils/driverOrderDiagnostics');

const ADMIN_A = 1000000001;
const ADMIN_B = 1000000002;
const SCREENSHOT = 'A'.repeat(200);

function stubCtx(behaviour = {}) {
    const sent = { photo: [], document: [], message: [] };
    return {
        sent,
        from: { id: 42 },
        telegram: {
            async sendPhoto(adminId, source, options) {
                sent.photo.push({ adminId, source, options });
                if (behaviour.photoFails) throw new Error('PHOTO_REJECTED');
            },
            async sendDocument(adminId, source, options) {
                sent.document.push({ adminId, source, options });
                if (behaviour.documentFails) throw new Error('DOCUMENT_REJECTED');
            },
            async sendMessage(adminId, text) {
                sent.message.push({ adminId, text });
                if (behaviour.messageFails) throw new Error('MESSAGE_REJECTED');
            },
        },
    };
}

const failure = {
    error: 'SCRAPER_DOWN',
    status: 'FAILED',
    diagnosticStep: 'FLEET_ORDER_LOOKUP',
    actionId: 'action-1',
    result: { shortOrderId: 'ORD-7' },
    diagnosticImageBase64: SCREENSHOT,
};

test('classifies pre-Fleet stops and the onboarding suppression', () => {
    assert.equal(stoppedBeforeFleet({ error: 'NOT_LINKED' }), true);
    assert.equal(stoppedBeforeFleet({ error: 'NO_YANDEX_ID' }), true);
    assert.equal(stoppedBeforeFleet({ error: 'LINK_INCOMPLETE' }), true);
    assert.equal(stoppedBeforeFleet({ preFleet: true }), true);
    assert.equal(stoppedBeforeFleet({ error: 'SCRAPER_DOWN' }), false);

    assert.equal(shouldNotifyManagerAboutFailure({ error: 'NOT_LINKED' }), false);
    assert.equal(shouldNotifyManagerAboutFailure({ error: 'NO_YANDEX_ID' }), true);
    assert.equal(shouldNotifyManagerAboutFailure({ error: 'SCRAPER_DOWN' }), true);
});

test('reads the plural setting, the legacy singular one, and every separator', () => {
    assert.deepEqual(diagnosticAdminIds({ ADMIN_IDS: `${ADMIN_A},${ADMIN_B}` }), [ADMIN_A, ADMIN_B]);
    assert.deepEqual(diagnosticAdminIds({ ADMIN_IDS: `${ADMIN_A}; ${ADMIN_B}` }), [ADMIN_A, ADMIN_B]);
    assert.deepEqual(diagnosticAdminIds({ ADMIN_ID: String(ADMIN_A) }), [ADMIN_A]);
    assert.deepEqual(
        diagnosticAdminIds({ ADMIN_IDS: String(ADMIN_A), ADMIN_ID: String(ADMIN_A) }),
        [ADMIN_A],
        'duplicates collapse to one notification',
    );
    assert.deepEqual(diagnosticAdminIds({ ADMIN_IDS: 'not-an-id' }), []);
    assert.deepEqual(diagnosticAdminIds({}), [], 'nothing configured sends nothing');
});

test('A. a qualifying failure pages the manager', async () => {
    const ctx = stubCtx();
    const deliveries = await notifyManagerAboutFailure(ctx, failure, { ADMIN_IDS: String(ADMIN_A) });

    assert.equal(ctx.sent.photo.length, 1);
    assert.equal(ctx.sent.photo[0].adminId, ADMIN_A);
    assert.match(ctx.sent.photo[0].options.caption, /Ошибка действия с заказом/);
    assert.match(ctx.sent.photo[0].options.caption, /FLEET_ORDER_LOOKUP/);
    assert.match(ctx.sent.photo[0].options.caption, /ORD-7/);
    assert.deepEqual(deliveries, [{ adminId: ADMIN_A, status: 'delivered', method: 'photo' }]);
});

test('B. NOT_LINKED raises no manager incident', async () => {
    const ctx = stubCtx();
    const deliveries = await notifyManagerAboutFailure(
        ctx, { error: 'NOT_LINKED' }, { ADMIN_IDS: String(ADMIN_A) },
    );

    assert.deepEqual(deliveries, []);
    assert.equal(ctx.sent.photo.length, 0);
    assert.equal(ctx.sent.document.length, 0);
    assert.equal(ctx.sent.message.length, 0);
});

test('C. a successful photo uses no fallback', async () => {
    const ctx = stubCtx();
    await notifyManagerAboutFailure(ctx, failure, { ADMIN_IDS: String(ADMIN_A) });

    assert.equal(ctx.sent.photo.length, 1);
    assert.equal(ctx.sent.document.length, 0);
    assert.equal(ctx.sent.message.length, 0);
});

test('D. a rejected photo falls back to a document', async () => {
    const ctx = stubCtx({ photoFails: true });
    const deliveries = await notifyManagerAboutFailure(ctx, failure, { ADMIN_IDS: String(ADMIN_A) });

    assert.equal(ctx.sent.document.length, 1);
    assert.equal(ctx.sent.document[0].source.filename, 'order-error-ORD-7.jpg');
    assert.equal(ctx.sent.message.length, 0);
    assert.deepEqual(deliveries, [{ adminId: ADMIN_A, status: 'delivered', method: 'document' }]);
});

test('E. both media sends failing falls back to bounded text', async () => {
    const ctx = stubCtx({ photoFails: true, documentFails: true });
    const deliveries = await notifyManagerAboutFailure(ctx, failure, { ADMIN_IDS: String(ADMIN_A) });

    assert.equal(ctx.sent.message.length, 1);
    assert.match(ctx.sent.message[0].text, /Скриншот сохранён в CRM/);
    assert.equal(deliveries[0].status, 'delivered');
    assert.equal(deliveries[0].method, 'text');
    assert.equal(deliveries[0].imageError, 'DOCUMENT_REJECTED');
});

test('E2. a failure with no screenshot goes straight to the text note', async () => {
    const ctx = stubCtx();
    await notifyManagerAboutFailure(
        ctx,
        { error: 'LINK_INCOMPLETE', preFleet: true },
        { ADMIN_IDS: String(ADMIN_A) },
    );

    assert.equal(ctx.sent.photo.length, 0);
    assert.equal(ctx.sent.document.length, 0);
    assert.equal(ctx.sent.message.length, 1);
    assert.match(ctx.sent.message[0].text, /остановлен до запуска Fleet/);
    assert.match(ctx.sent.message[0].text, /восстановить привязку водителя/);
});

test('E3. an undeliverable diagnostic is recorded, not thrown', async () => {
    const ctx = stubCtx({ photoFails: true, documentFails: true, messageFails: true });
    const deliveries = await notifyManagerAboutFailure(ctx, failure, { ADMIN_IDS: String(ADMIN_A) });

    assert.equal(deliveries[0].status, 'failed');
    assert.equal(deliveries[0].error, 'MESSAGE_REJECTED');
});

test('F. every configured manager receives exactly one notification', async () => {
    const ctx = stubCtx();
    const deliveries = await notifyManagerAboutFailure(
        ctx, failure, { ADMIN_IDS: `${ADMIN_A},${ADMIN_B}` },
    );

    assert.equal(ctx.sent.photo.length, 2);
    assert.deepEqual(ctx.sent.photo.map(p => p.adminId), [ADMIN_A, ADMIN_B]);
    assert.equal(deliveries.length, 2);
    assert.equal(ctx.sent.message.length, 0);
});

test('G. no CRM delivery-report action is emitted', () => {
    const diagnostics = readFileSync(
        path.resolve(__dirname, '../utils/driverOrderDiagnostics.js'), 'utf8',
    );
    const handler = readFileSync(
        path.resolve(__dirname, '../handlers/driverOrder.js'), 'utf8',
    );
    const code = source => source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    // The deployed Gravity lineage has no such action, so emitting it could only
    // produce a 4xx. Its absence here is deliberate and is a follow-up.
    assert.doesNotMatch(code(diagnostics), /report_diagnostic_delivery/);
    assert.doesNotMatch(code(handler), /report_diagnostic_delivery/);
    // The diagnostics module talks to Telegram only; it makes no CRM call.
    assert.doesNotMatch(code(diagnostics), /callCRM|require\(['"]https?['"]\)/);
});

test('H. the diagnostic never carries a hardcoded recipient', () => {
    const diagnostics = readFileSync(
        path.resolve(__dirname, '../utils/driverOrderDiagnostics.js'), 'utf8',
    );
    const code = diagnostics
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    // A built-in personal id would page one individual in every unconfigured
    // environment. Recipients come from configuration or there are none.
    assert.doesNotMatch(code, /\b\d{9,}\b/);
});

test('H2. reportFailure pages managers without swallowing the driver reply', () => {
    const handler = readFileSync(
        path.resolve(__dirname, '../handlers/driverOrder.js'), 'utf8',
    );

    assert.match(handler, /notifyManagerAboutFailure\(ctx, state\)/);
    // NOT_LINKED returns before the notification, so suppression holds.
    const reportFailure = handler.slice(handler.indexOf('async function reportFailure'));
    const notLinkedReturn = reportFailure.indexOf("state.error === 'NOT_LINKED'");
    const notify = reportFailure.indexOf('notifyManagerAboutFailure');
    assert.ok(notLinkedReturn >= 0 && notify > notLinkedReturn);
    // And the diagnostic is wrapped, so a Telegram outage cannot lose the
    // driver's own answer.
    assert.match(reportFailure.slice(notify - 200, notify + 200), /try\s*\{/);
});
