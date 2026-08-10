'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

function constantTimeEqual(left, right) {
    const leftDigest = createHash('sha256').update(String(left)).digest();
    const rightDigest = createHash('sha256').update(String(right)).digest();
    return timingSafeEqual(leftDigest, rightDigest);
}

function parseBasicAuthorization(header) {
    if (typeof header !== 'string') return null;

    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header.trim());
    if (!match) return null;

    try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 1) return null;
        return {
            username: decoded.slice(0, separator),
            password: decoded.slice(separator + 1),
        };
    } catch {
        return null;
    }
}

function isAcceptableAdminPassword(password) {
    if (typeof password !== 'string' || password.length < 12) return false;
    const normalized = password.trim().toLowerCase();
    if (['admin123', 'password', 'changeme'].includes(normalized)) return false;
    return !/(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i.test(normalized);
}

// The backend remains protected even though normal browser traffic is relayed
// by the frontend's authenticated, same-origin proxy. There are intentionally
// no fallback credentials: an incomplete deployment is unavailable, not open.
function adminAuth(req, res, next) {
    const validUsername = process.env.ADMIN_USER;
    const validPassword = process.env.ADMIN_PASS;

    if (!validUsername || !isAcceptableAdminPassword(validPassword)) {
        return res.status(503).json({ error: 'Admin authentication is not configured' });
    }

    const supplied = parseBasicAuthorization(req.headers.authorization);
    if (!supplied) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const usernameMatches = constantTimeEqual(supplied.username, validUsername);
    const passwordMatches = constantTimeEqual(supplied.password, validPassword);
    if (!usernameMatches || !passwordMatches) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
}

module.exports = adminAuth;
module.exports.constantTimeEqual = constantTimeEqual;
module.exports.isAcceptableAdminPassword = isAcceptableAdminPassword;
module.exports.parseBasicAuthorization = parseBasicAuthorization;
