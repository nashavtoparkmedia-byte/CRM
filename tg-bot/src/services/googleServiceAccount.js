'use strict';

const path = require('node:path');

function googleServiceAccountOptions(value, cwd = process.cwd()) {
    const configured = String(value || '').trim();
    if (!configured) return { keyFile: path.resolve(cwd, 'service-account.json') };

    if (configured.startsWith('{')) {
        let credentials;
        try {
            credentials = JSON.parse(configured);
        } catch {
            throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_INVALID_JSON');
        }
        if (credentials?.type !== 'service_account'
            || typeof credentials.client_email !== 'string'
            || typeof credentials.private_key !== 'string') {
            throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_INVALID');
        }
        return { credentials };
    }

    return { keyFile: path.resolve(cwd, configured) };
}

module.exports = { googleServiceAccountOptions };
