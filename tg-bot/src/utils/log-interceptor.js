'use strict';

const fs = require('fs');
const { sanitizeLogValue, redactText } = require('../security/redactSecrets');

if (!global.__yokoSafeConsoleInstalled) {
    global.__yokoSafeConsoleInstalled = true;

    for (const level of ['error', 'log', 'warn', 'info', 'debug']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            const safeArgs = args.map(value => sanitizeLogValue(value));
            const line = safeArgs.map(value => {
                if (typeof value === 'object') {
                    try { return JSON.stringify(value); } catch { return '[Unserializable]'; }
                }
                return String(value);
            }).join(' ');
            try {
                fs.appendFileSync(
                    'bot-errors.log',
                    `${new Date().toISOString()} ${level.toUpperCase()} ${redactText(line)}\n`,
                    { encoding: 'utf8', mode: 0o600 },
                );
            } catch {
                // Logging must never terminate the bot.
            }
            original(...safeArgs);
        };
    }
}
