const {
    createHmac,
    createHash,
    randomBytes,
    timingSafeEqual,
} = require('node:crypto');

const SESSION_COOKIE = 'yoko_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function constantTimeEqual(left, right) {
    const leftDigest = createHash('sha256').update(String(left)).digest();
    const rightDigest = createHash('sha256').update(String(right)).digest();
    return timingSafeEqual(leftDigest, rightDigest);
}

function isAcceptableAdminPassword(password) {
    if (typeof password !== 'string' || password.length < 12) return false;
    const normalized = password.trim().toLowerCase();
    if (['admin123', 'password', 'changeme'].includes(normalized)) return false;
    return !/(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i.test(normalized);
}

function configuredCredentials() {
    const username = process.env.ADMIN_USER;
    const password = process.env.ADMIN_PASS;
    if (!username || !isAcceptableAdminPassword(password)) return null;
    return { username, password };
}

function authenticateCredentials(username, password) {
    const configured = configuredCredentials();
    if (!configured || typeof username !== 'string' || typeof password !== 'string') {
        return false;
    }

    // Evaluate both comparisons so the username is not an early-exit oracle.
    const usernameMatches = constantTimeEqual(username, configured.username);
    const passwordMatches = constantTimeEqual(password, configured.password);
    return usernameMatches && passwordMatches;
}

function isAcceptableSessionSecret(secret) {
    if (typeof secret !== 'string' || secret.length < 32) return false;
    return !/(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i.test(secret.trim());
}

function signingKey() {
    // ADMIN_SESSION_SECRET permits independent session rotation. Deriving from
    // ADMIN_PASS retains compatibility with the existing deployment ABI while
    // keeping the credential exclusively on the server.
    const explicitSecret = process.env.ADMIN_SESSION_SECRET;
    if (explicitSecret) {
        return isAcceptableSessionSecret(explicitSecret) ? explicitSecret : null;
    }
    return configuredCredentials()?.password || null;
}

function sign(encodedPayload) {
    const key = signingKey();
    if (!key) return null;
    return createHmac('sha256', key).update(encodedPayload).digest('base64url');
}

function createSessionToken(now = Date.now()) {
    const configured = configuredCredentials();
    if (!configured || !signingKey()) return null;

    const payload = Buffer.from(JSON.stringify({
        version: 1,
        username: configured.username,
        expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
        nonce: randomBytes(16).toString('base64url'),
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

    const expectedSignature = sign(parts[0]);
    if (!expectedSignature || !constantTimeEqual(parts[1], expectedSignature)) return false;

    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const configured = configuredCredentials();
        return Boolean(
            configured
            && payload.version === 1
            && typeof payload.expiresAt === 'number'
            && payload.expiresAt > Math.floor(now / 1000)
            && payload.expiresAt <= Math.floor(now / 1000) + SESSION_TTL_SECONDS
            && constantTimeEqual(payload.username, configured.username)
        );
    } catch {
        return false;
    }
}

function parseCookies(cookieHeader) {
    if (typeof cookieHeader !== 'string') return {};
    return Object.fromEntries(cookieHeader.split(';').flatMap(part => {
        const separator = part.indexOf('=');
        if (separator < 1) return [];
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            return [[name, decodeURIComponent(value)]];
        } catch {
            return [];
        }
    }));
}

function requestHasValidSession(req, now = Date.now()) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return verifySessionToken(token, now);
}

function sessionCookie(token) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function expiredSessionCookie() {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

module.exports = {
    SESSION_COOKIE,
    SESSION_TTL_SECONDS,
    authenticateCredentials,
    configuredCredentials,
    createSessionToken,
    expiredSessionCookie,
    isAcceptableAdminPassword,
    isAcceptableSessionSecret,
    requestHasValidSession,
    sessionCookie,
    verifySessionToken,
};
