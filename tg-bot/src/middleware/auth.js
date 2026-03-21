// Simple Basic Auth middleware for protecting Admin API
function adminAuth(req, res, next) {
    let authHeader = req.headers.authorization;

    // Support token in query params for direct downloads/diagnostics
    if (!authHeader && req.query.token) {
        authHeader = `Basic ${req.query.token}`;
    }

    if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Missing Authorization header' });
    }

    // Expecting Basic Auth: Basic base64(admin:password)
    const parts = authHeader.split(' ');
    const type = parts[0];
    const credentials = parts[1];

    if (type !== 'Basic' || !credentials) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid Authorization format' });
    }

    const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');

    // Read credentials from .env to match the project's config
    const validUsername = process.env.ADMIN_USER || 'admin';
    const validPassword = process.env.ADMIN_PASS || 'admin123';

    if (username === validUsername && password === validPassword) {
        next(); // Authentication successful
    } else {
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
    }
}

module.exports = adminAuth;
