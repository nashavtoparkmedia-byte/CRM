'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotSingletonLock } = require('./botSingletonLock');

function fakeClient(acquired = true) {
    return {
        calls: [],
        ended: false,
        on() {},
        async connect() { this.calls.push(['connect']); },
        async query(sql, values) {
            this.calls.push([sql, values]);
            return { rows: [{ acquired }] };
        },
        async end() { this.ended = true; },
    };
}

test('holds a shared PostgreSQL advisory lock until release', async () => {
    const client = fakeClient();
    const lock = createBotSingletonLock({
        Client: class { constructor() { return client; } },
        env: { DATABASE_URL: 'postgresql://test.invalid/db' },
    });

    await lock.acquire();
    assert.equal(lock.held, true);
    assert.deepEqual(client.calls[1], ['SELECT pg_try_advisory_lock($1, $2) AS acquired', [17365, 20261124]]);

    await lock.release();
    assert.equal(lock.held, false);
    assert.equal(client.ended, true);
});

test('refuses to start when another process holds the lock', async () => {
    const client = fakeClient(false);
    const lock = createBotSingletonLock({
        Client: class { constructor() { return client; } },
        env: { DATABASE_URL: 'postgresql://test.invalid/db' },
    });

    await assert.rejects(lock.acquire(), { message: 'BOT_SINGLETON_ALREADY_RUNNING' });
    assert.equal(lock.held, false);
    assert.equal(client.ended, true);
});

test('requires a database connection string before creating a lock', async () => {
    const lock = createBotSingletonLock({ Client: class {}, env: {} });
    await assert.rejects(lock.acquire(), { message: 'BOT_SINGLETON_DATABASE_URL_REQUIRED' });
});

test('releases the advisory lock when startup work fails after acquisition', async () => {
    const client = fakeClient();
    const lock = createBotSingletonLock({
        Client: class { constructor() { return client; } },
        env: { DATABASE_URL: 'postgresql://test.invalid/db' },
    });

    await assert.rejects(
        lock.runWithLock(async () => { throw new Error('startup failed'); }),
        { message: 'startup failed' },
    );
    assert.equal(lock.held, false);
    assert.equal(client.ended, true);
});
