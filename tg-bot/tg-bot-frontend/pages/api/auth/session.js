const { requestHasValidSession } = require('../../../lib/serverAuth');

export default function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requestHasValidSession(req)) {
        return res.status(401).json({ authenticated: false });
    }
    return res.status(200).json({ authenticated: true });
}
