const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/admin/surveys',
    method: 'GET'
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log(`Status /surveys: ${res.statusCode}`);
        if (res.statusCode !== 401) {
            console.log(data);
        }
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});
req.end();
