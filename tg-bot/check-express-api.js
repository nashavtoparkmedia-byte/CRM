const http = require('http');
require('dotenv').config();

if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    throw new Error('ADMIN_USER and ADMIN_PASS are required');
}

const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/admin/surveys/bbd15c7a-c378-41d5-87bc-e917bde5ada4/analytics',
    method: 'GET',
    headers: {
        'Authorization': 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64'),
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Body: ${data}`);
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});
req.end();
