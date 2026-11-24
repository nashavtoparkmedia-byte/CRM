'use strict';

// Stable application lock identity shared by all YOKO Telegram bot processes
// that connect to the same CRM PostgreSQL database.
const LOCK_NAMESPACE = 17365;
const LOCK_ID = 20261124;

function createBotSingletonLock(options = {}) {
    const ClientConstructor = options.Client;
    const env = options.env || process.env;
    let client = null;
    let held = false;

    async function acquire() {
        if (held) return;
        const connectionString = env.DATABASE_URL;
        if (typeof connectionString !== 'string' || !connectionString.trim()) {
            throw new Error('BOT_SINGLETON_DATABASE_URL_REQUIRED');
        }

        const PgClient = ClientConstructor || require('pg').Client;
        const candidate = new PgClient({
            connectionString,
            application_name: 'yoko-tg-bot-singleton',
        });
        await candidate.connect();
        candidate.on('error', () => {
            // A lost lock connection must terminate the process. Restart policy
            // can then reacquire the lock; continuing could create two pollers.
            process.exit(1);
        });

        try {
            const result = await candidate.query(
                'SELECT pg_try_advisory_lock($1, $2) AS acquired',
                [LOCK_NAMESPACE, LOCK_ID],
            );
            if (result.rows?.[0]?.acquired !== true) {
                throw new Error('BOT_SINGLETON_ALREADY_RUNNING');
            }
            client = candidate;
            held = true;
        } catch (error) {
            await candidate.end().catch(() => {});
            throw error;
        }
    }

    async function release() {
        if (!client) return;
        const active = client;
        client = null;
        held = false;
        try {
            await active.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_ID]);
        } finally {
            await active.end();
        }
    }

    async function runWithLock(operation) {
        await acquire();
        try {
            return await operation();
        } catch (error) {
            await release();
            throw error;
        }
    }

    return { acquire, release, runWithLock, get held() { return held; } };
}

const singletonLock = createBotSingletonLock();
module.exports = singletonLock;
module.exports.createBotSingletonLock = createBotSingletonLock;
