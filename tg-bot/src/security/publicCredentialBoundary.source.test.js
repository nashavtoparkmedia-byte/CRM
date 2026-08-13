'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = relative => readFileSync(resolve(root, relative), 'utf8');

test('admin bot responses are projected from explicit non-token selects', () => {
    const source = read('src/routes/admin/bots.js');
    const ownerCapability = read('src/public-bot-maintenance.js');
    assert.match(source, /const publicBotSelect = \{/);
    assert.match(source, /projectBotMetadata\(bot\)/);
    assert.doesNotMatch(source, /res\.json\(bot\)/);
    assert.doesNotMatch(source, /res\.status\(201\)\.json\(bot\)/);
    assert.doesNotMatch(source, /last_bot_error|writeFileSync/);
    assert.match(ownerCapability, /const adminBotPublicSelect = Object\.freeze\(\{/);
    assert.match(ownerCapability, /prisma\.bot\.create\(\{[\s\S]*select: adminBotPublicSelect/);
    const select = ownerCapability.split('const adminBotPublicSelect = Object.freeze({', 2)[1].split('})', 1)[0];
    assert.doesNotMatch(select, /\btoken\s*:/);
});

test('user list relation contains bot metadata but never Bot.token', () => {
    const source = read('src/routes/admin/users.js');
    const listHandler = source.split('// GET answers history for a user', 1)[0];
    assert.match(listHandler, /bot:\s*\{\s*select:\s*\{ id: true, name: true, username: true, isActive: true \}/s);
    assert.doesNotMatch(listHandler, /bot:\s*true/);
    assert.doesNotMatch(listHandler, /token:\s*true/);
});
