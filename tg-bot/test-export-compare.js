const http = require('http');
const fs = require('fs');

const SURVEY_ID = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';

function download(label, port, path) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: 'localhost', port, path }, (res) => {
            console.log(`\n=== ${label} ===`);
            console.log(`Status: ${res.statusCode}`);
            console.log(`Headers:`, JSON.stringify(res.headers, null, 2));

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                console.log(`Bytes received: ${buf.length}`);
                const isZip = buf[0] === 0x50 && buf[1] === 0x4B;
                console.log(`Valid XLSX (ZIP) signature: ${isZip ? 'YES' : 'NO'}`);
                if (!isZip) {
                    console.log(`Content preview: ${buf.toString('utf8').substring(0, 300)}`);
                }
                resolve(buf);
            });
        });
        req.on('error', (err) => {
            console.error(`\n=== ${label} ERROR: ${err.code} - ${err.message} ===`);
            resolve(null);
        });
    });
}

async function main() {
    console.log('--- Testing export endpoints ---');

    const backend = await download('BACKEND (port 3001)', 3001, `/api/admin/surveys/${SURVEY_ID}/export?all=true`);
    if (backend) fs.writeFileSync('test_backend.xlsx', backend);

    const proxy = await download('PROXY (port 3002)', 3002, `/api/export?surveyId=${SURVEY_ID}&all=true&filename=test.xlsx`);
    if (proxy) fs.writeFileSync('test_proxy.xlsx', proxy);

    if (backend && proxy) {
        console.log(`\n=== COMPARE ===`);
        console.log(`Backend: ${backend.length} bytes, Proxy: ${proxy.length} bytes`);
        console.log(`Identical: ${backend.equals(proxy)}`);
    }
}

main();
