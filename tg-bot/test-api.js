const http = require('http');

console.log('Testing GET http://localhost:3001/api/admin/surveys');

const req = http.get({
    hostname: 'localhost',
    port: 3001,
    path: '/api/admin/surveys',
    headers: {
        'Authorization': 'Basic ' + Buffer.from('admin:admin').toString('base64')
    }
}, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
        console.log('Status Code:', res.statusCode);
        try {
            const json = JSON.parse(data);
            console.log('Data:', JSON.stringify(json, null, 2));
        } catch (e) {
            console.log('Raw Data:', data);
        }
    });
});

req.on('error', e => console.error('Connection Error:', e.message));
req.end();
