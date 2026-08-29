'use strict';

function registrationPayload(user, attemptAutoLink) {
    return {
        telegramId: String(user.telegram_id ?? user.telegramId),
        username: user.username || null,
        firstName: user.first_name ?? user.firstName ?? null,
        lastName: user.last_name ?? user.lastName ?? null,
        phone: user.phone || null,
        phoneVerified: Boolean(user.phone_verified ?? user.phoneVerified),
        attemptAutoLink,
    };
}

module.exports = { registrationPayload };
