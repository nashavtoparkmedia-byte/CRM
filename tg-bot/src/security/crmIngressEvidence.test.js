'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
    CrmIntegrationService,
    extractTelegramProviderEvidence,
    normalizeCrmTelegramWebhookUrl,
} = require('../services/crmIntegration');

const repositoryRoot = path.resolve(__dirname, '../../..');

test('normalizes the shared CRM origin only for Telegram message forwarding', () => {
    assert.equal(
        normalizeCrmTelegramWebhookUrl('http://gravity-mvp:3002'),
        'http://gravity-mvp:3002/api/webhook/telegram',
    );
    assert.equal(
        normalizeCrmTelegramWebhookUrl('http://gravity-mvp:3002/api/webhook/telegram'),
        'http://gravity-mvp:3002/api/webhook/telegram',
    );
    assert.equal(
        normalizeCrmTelegramWebhookUrl('http://gravity-mvp:3002/api/webhooks/bot'),
        'http://gravity-mvp:3002/api/webhooks/bot',
    );

    const previous = process.env.CRM_WEBHOOK_URL;
    process.env.CRM_WEBHOOK_URL = 'http://gravity-mvp:3002';
    try {
        assert.equal(
            new CrmIntegrationService().crmWebhookUrl,
            'http://gravity-mvp:3002/api/webhook/telegram',
        );
    } finally {
        if (previous === undefined) delete process.env.CRM_WEBHOOK_URL;
        else process.env.CRM_WEBHOOK_URL = previous;
    }
});

test('shared production env provisions exact Telegram transport and connection bindings', () => {
    const envExample = readFileSync(path.join(repositoryRoot, '.env.production.example'), 'utf8');
    const compose = readFileSync(path.join(repositoryRoot, 'deploy/docker-compose.production.yml'), 'utf8');
    const gravityService = compose.split('\n  gravity-mvp:')[1].split('\n  tg-bot:')[0];
    const botService = compose.split('\n  tg-bot:')[1].split('\n  tg-bot-frontend:')[0];

    assert.match(envExample, /^CRM_TELEGRAM_CONNECTION_ID=driver-bot-primary$/m);
    assert.match(envExample, /^TG_BOT_API_URL=http:\/\/tg-bot:3001$/m);
    assert.match(gravityService, /env_file:\s*\n\s*- \.\.\/\.env\.production/);
    assert.match(botService, /env_file:\s*\n\s*- \.\.\/\.env\.production/);
    assert.match(botService, /CRM_WEBHOOK_URL: http:\/\/gravity-mvp:3002(?:\s|$)/);
});

test('derives retry-stable event identity only from live Telegraf evidence', () => {
    const evidence = extractTelegramProviderEvidence({
        botInfo: { id: 123 },
        update: { update_id: 456 },
        message: { message_id: 789, date: 1788372000 },
    });
    assert.deepEqual(evidence, {
        providerAccountId: '123',
        providerUpdateId: '456',
        providerMessageId: '789',
        callbackQueryId: null,
        providerEventId: 'update:456',
        observedAt: new Date(1788372000 * 1000).toISOString(),
    });
});

test('does not treat configured account IDs as live ingress evidence', () => {
    const previous = process.env.TELEGRAM_BOT_ACCOUNT_ID;
    process.env.TELEGRAM_BOT_ACCOUNT_ID = 'configured-but-unattested';
    try {
        assert.equal(extractTelegramProviderEvidence({
            update: { update_id: 456 },
            message: { message_id: 789 },
        }), null);
        assert.equal(extractTelegramProviderEvidence({
            botInfo: { id: 123 },
            message: { message_id: 789 },
        }), null);
    } finally {
        if (previous === undefined) delete process.env.TELEGRAM_BOT_ACCOUNT_ID;
        else process.env.TELEGRAM_BOT_ACCOUNT_ID = previous;
    }
});

test('uses callback-query IDs when no new provider message exists', () => {
    assert.deepEqual(extractTelegramProviderEvidence({
        botInfo: { id: 123 },
        update: { update_id: 456 },
        callbackQuery: { id: 'opaque-callback-id', message: { date: 1788372000 } },
    }), {
        providerAccountId: '123',
        providerUpdateId: '456',
        providerMessageId: null,
        callbackQueryId: 'opaque-callback-id',
        providerEventId: 'update:456',
        observedAt: new Date(1788372000 * 1000).toISOString(),
    });
});
