'use strict';

const FORBIDDEN_PUBLIC_CREDENTIAL_KEYS = Object.freeze([
    'apiKey',
    'apiHash',
    'sessionString',
    'botToken',
    'sessionData',
    'apiKeyEncrypted',
    'token',
]);

function assertNoPublicCredentialKeys(value, path = '$', seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoPublicCredentialKeys(entry, `${path}[${index}]`, seen));
        return;
    }

    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_PUBLIC_CREDENTIAL_KEYS.includes(key)) {
            throw new Error(`Credential-bearing key is forbidden in a public DTO: ${path}.${key}`);
        }
        assertNoPublicCredentialKeys(entry, `${path}.${key}`, seen);
    }
}

function projectBotMetadata(bot, tokenConfigured = true) {
    const dto = {
        id: bot.id,
        name: bot.name,
        username: bot.username ?? null,
        isActive: bot.isActive,
        createdAt: bot.createdAt,
        tokenConfigured: Boolean(tokenConfigured),
        ...(bot.surveys === undefined ? {} : { surveys: bot.surveys }),
        ...(bot._count === undefined ? {} : { _count: bot._count }),
    };
    assertNoPublicCredentialKeys(dto);
    return dto;
}

module.exports = {
    FORBIDDEN_PUBLIC_CREDENTIAL_KEYS,
    assertNoPublicCredentialKeys,
    projectBotMetadata,
};
