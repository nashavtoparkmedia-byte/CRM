const http = require('http');

const botId = '6f11cd83-a56d-4c54-8800-2253eacb90ab';
console.log(`Fetching dashboard for ${botId}...`);

const options = {
    hostname: 'localhost',
    port: 3001,
    path: `/api/admin/dashboard?botId=${botId}&period=30d`,
    method: 'GET',
    headers: {
        'Authorization': 'Bearer test',
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        try {
            const parsedData = JSON.parse(data);
            console.log("Dashboard Data:");
            console.log(JSON.stringify(parsedData, null, 2));
        } catch (e) {
            console.log("Raw Output:", data);
        }
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});

req.end();
