'use strict';

const crypto = require('crypto');

const MIN_BOT_CRM_SECRET_LENGTH = 32;
const MAX_BOT_CRM_SECRET_LENGTH = 256;
const PLACEHOLDER_PATTERN = /(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate|your[-_ ]?secret)/i;

function isAcceptableBotCrmSecret(value) {
    if (typeof value !== 'string') return false;
    const secret = value.trim();
    if (secret.length < MIN_BOT_CRM_SECRET_LENGTH || secret.length > MAX_BOT_CRM_SECRET_LENGTH) return false;
    if (PLACEHOLDER_PATTERN.test(secret) || /^(.)\1+$/.test(secret)) return false;
    return true;
}

function getRequiredBotCrmSecret(value = process.env.BOT_CRM_SECRET) {
    if (!isAcceptableBotCrmSecret(value)) throw new Error('BOT_CRM_SECRET_INVALID');
    return value.trim();
}

function constantTimeSecretEqual(supplied, expected) {
    if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) return false;
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { constantTimeSecretEqual, getRequiredBotCrmSecret, isAcceptableBotCrmSecret };
