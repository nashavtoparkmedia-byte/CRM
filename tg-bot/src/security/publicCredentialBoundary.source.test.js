'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const read = relative => readFileSync(resolve(root, relative), 'utf8');

test('admin bot responses are projected from explicit non-token selects', () => {
    const source = read('src/routes/admin/bots.js');
    assert.match(source, /const publicBotSelect = \{/);
    assert.match(source, /projectBotMetadata\(bot\)/);
    assert.doesNotMatch(source, /res\.json\(bot\)/);
    assert.doesNotMatch(source, /res\.status\(201\)\.json\(bot\)/);
    assert.doesNotMatch(source, /last_bot_error|writeFileSync/);
});

test('user list relation contains bot metadata but never Bot.token', () => {
    const source = read('src/routes/admin/users.js');
    const listHandler = source.split('// GET answers history for a user', 1)[0];
    assert.match(listHandler, /bot:\s*\{\s*select:\s*\{ id: true, name: true, username: true, isActive: true \}/s);
    assert.doesNotMatch(listHandler, /bot:\s*true/);
    assert.doesNotMatch(listHandler, /token:\s*true/);
});
