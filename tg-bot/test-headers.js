const http = require('http');
require('dotenv').config();

if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    throw new Error('ADMIN_USER and ADMIN_PASS are required');
}
const authorization = `Basic ${Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64')}`;
const surveyId = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';

// Test with filename in path
const url = `http://localhost:3001/api/admin/surveys/${surveyId}/export/myfile.xlsx`;

console.log('Testing URL:', url);
console.log('---');

http.get(url, { headers: { Authorization: authorization } }, (res) => {
    console.log('Status:', res.statusCode);
    console.log('Headers:');
    Object.entries(res.headers).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
    });

    let size = 0;
    res.on('data', (chunk) => { size += chunk.length; });
    res.on('end', () => {
        console.log('---');
        console.log('Body size:', size, 'bytes');
    });
}).on('error', (e) => {
    console.error('Error:', e.message);
});
