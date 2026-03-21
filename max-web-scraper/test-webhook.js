const fetch = require('node-fetch');
fetch('http://localhost:3001/api/webhook/max', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        phone: '79222155750',
        text: 'TEST_MSG_VIA_SCRIPT',
        driverName: 'test',
        timestamp: new Date().toISOString()
    })
})
.then(r => r.text().then(text => console.log("STATUS:", r.status, "BODY:", text)))
.catch(console.error);
