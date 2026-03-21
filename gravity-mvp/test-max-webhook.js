const fetch = require('node-fetch');

async function test() {
    console.log('Sending mock message from MAX to CRM webhook...');
    const res = await fetch('http://localhost:3002/api/webhook/max', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            phone: 'Александр',
            driverName: 'Александр',
            text: 'Auto webhook link test - 22:45',
            timestamp: new Date().toISOString()
        })
    });
    const data = await res.json();
    console.log('Webhook Response:', data);
}

test().catch(console.error);
