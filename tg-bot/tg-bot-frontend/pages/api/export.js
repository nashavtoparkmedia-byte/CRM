// Next.js API proxy for Excel export (same-origin direct download)
const http = require('http');

export const config = {
    api: {
        responseLimit: false,
    },
};

export default function handler(req, res) {
    const { surveyId, all, columns, filename, token } = req.query;

    if (!surveyId) {
        return res.status(400).json({ error: 'surveyId is required' });
    }

    // Build backend URL
    let backendPath = `/api/admin/surveys/${surveyId}/export`;
    const backendParams = new URLSearchParams();
    if (token) backendParams.set('token', token);
    if (all === 'true') backendParams.set('all', 'true');
    if (columns) backendParams.set('columns', columns);

    const backendUrl = `${backendPath}?${backendParams.toString()}`;
    const exportFilename = filename || `survey_export.xlsx`;

    // Stream the response from backend directly to client
    const proxyReq = http.request({
        hostname: 'localhost',
        port: 3001,
        path: backendUrl,
        method: 'GET',
    }, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
            res.status(proxyRes.statusCode).json({ error: 'Backend error' });
            return;
        }

        // Set download headers on same-origin response
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${exportFilename}"`);

        if (proxyRes.headers['content-length']) {
            res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }

        res.status(200);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('Export proxy error:', err.message);
        res.status(500).json({ error: 'Failed to connect to backend' });
    });

    proxyReq.end();
}
