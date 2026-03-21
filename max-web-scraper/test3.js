const fetch = require('node-fetch');

async function run() {
    try {
        console.log("Sending POST to http://localhost:3002/api/webhook/max...");
        const response = await fetch('http://127.0.0.1:3002/api/webhook/max', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: '79222155750',
                text: 'TEST_PORT_3002',
                driverName: 'test',
                timestamp: new Date().toISOString()
            }),
            timeout: 5000 // 5 seconds
        });
        
        console.log("HTTP STATUS:", response.status);
        const text = await response.text();
        console.log("RESPONSE BODY:", text);
    } catch (e) {
        console.log("ERROR RUNNING FETCH:", e.message);
    }
}

run();
