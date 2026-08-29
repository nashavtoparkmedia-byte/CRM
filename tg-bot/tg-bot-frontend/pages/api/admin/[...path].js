const http = require('node:http');
const https = require('node:https');
const {
    configuredCredentials,
    requestHasValidSession,
} = require('../../../lib/serverAuth');

export const config = {
    api: {
        bodyParser: false,
        responseLimit: false,
    },
};

function addQueryValue(searchParams, name, value) {
    if (Array.isArray(value)) {
        value.forEach(item => searchParams.append(name, String(item)));
    } else if (value !== undefined) {
        searchParams.append(name, String(value));
    }
}

export default function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!requestHasValidSession(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const credentials = configuredCredentials();
    const configuredApiUrl = process.env.TG_BOT_API_URL;
    if (!credentials || (!configuredApiUrl && process.env.NODE_ENV === 'production')) {
        return res.status(503).json({ error: 'Admin upstream is not configured' });
    }

    let upstream;
    try {
        upstream = new URL(configuredApiUrl || 'http://localhost:3001');
    } catch {
        return res.status(503).json({ error: 'Admin upstream is not configured' });
    }
    if (!['http:', 'https:'].includes(upstream.protocol)) {
        return res.status(503).json({ error: 'Admin upstream is not configured' });
    }

    const path = Array.isArray(req.query.path) ? req.query.path : [];
    upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}/api/admin/${path.map(encodeURIComponent).join('/')}`;
    upstream.search = '';
    for (const [name, value] of Object.entries(req.query)) {
        if (name !== 'path' && name !== 'token') addQueryValue(upstream.searchParams, name, value);
    }

    const transport = upstream.protocol === 'https:' ? https : http;
    const headers = {
        Accept: req.headers.accept || '*/*',
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];

    const proxyReq = transport.request(upstream, {
        method: req.method,
        headers,
        timeout: 30_000,
    }, proxyRes => {
        res.statusCode = proxyRes.statusCode || 502;
        for (const name of ['content-type', 'content-length', 'content-disposition']) {
            const value = proxyRes.headers[name];
            if (value !== undefined) res.setHeader(name, value);
        }
        proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => proxyReq.destroy(new Error('Admin upstream timed out')));
    proxyReq.on('error', () => {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Admin upstream unavailable' });
        } else {
            res.destroy();
        }
    });
    req.pipe(proxyReq);
    return undefined;
}
