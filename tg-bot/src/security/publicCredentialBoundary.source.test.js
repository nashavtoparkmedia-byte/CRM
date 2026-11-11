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

const { readdirSync } = require('node:fs');

function runtimeSources(directory = resolve(root, 'src')) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...runtimeSources(absolute));
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(absolute);
    }
    return files;
}

test('BOT_CRM_SECRET has one reader and no fallback value anywhere in the bot', () => {
    const readers = [];
    for (const file of runtimeSources()) {
        const source = readFileSync(file, 'utf8');
        const relative = file.slice(root.length + 1);
        assert.doesNotMatch(source, /BOT_CRM_SECRET\s*(?:\|\||\?\?)/, `${relative} falls back from BOT_CRM_SECRET`);
        assert.doesNotMatch(source, /['"]x-bot-signature['"]\s*:\s*['"]/, `${relative} signs with a literal`);
        if (/\.BOT_CRM_SECRET\b/.test(source)) readers.push(relative);
    }
    assert.deepEqual(readers, ['src/security/webhookAuth.js']);
});

test('no bot send path or admin check names a numeric Telegram user id', () => {
    for (const file of runtimeSources()) {
        const source = readFileSync(file, 'utf8');
        const relative = file.slice(root.length + 1);
        assert.doesNotMatch(source, /\bsend(?:Message|Photo|Document|MediaGroup)\(\s*\d{5,}/, `${relative} sends to a literal id`);
        assert.doesNotMatch(source, /\bconst\s+ADMIN\w*\s*=\s*\[?\s*\d{5,}/, `${relative} hard-codes an admin id`);
        assert.doesNotMatch(source, /\(ID:\s*\d{5,}\)/, `${relative} documents a personal id`);
    }
    const connection = read('src/handlers/connection.js');
    assert.match(connection, /const adminIds = diagnosticAdminIds\(\);\n    if \(adminIds\.length === 0\) return;/);
    assert.match(connection, /await ctx\.telegram\.sendMessage\(adminId, message,/);
    assert.match(read('src/handlers/start.js'), /return diagnosticAdminIds\(\)\.includes\(Number\(userId\)\);/);
});
