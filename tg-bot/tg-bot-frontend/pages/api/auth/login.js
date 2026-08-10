const {
    authenticateCredentials,
    configuredCredentials,
    createSessionToken,
    sessionCookie,
} = require('../../../lib/serverAuth');

export default function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!configuredCredentials()) {
        return res.status(503).json({ error: 'Admin authentication is not configured' });
    }

    const { username, password } = req.body || {};
    if (!authenticateCredentials(username, password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSessionToken();
    if (!token) {
        return res.status(503).json({ error: 'Admin authentication is not configured' });
    }

    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.status(200).json({ authenticated: true });
}
