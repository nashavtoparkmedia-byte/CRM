const http = require('http');

async function send(chatId, message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chatId: String(chatId), message });
    const req = http.request({
      hostname: 'localhost',
      port: 3005,
      path: '/send-message',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`status=${res.statusCode} body=${body}`);
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Correct MAX internal chatId for +79222155750
  const chatId = '201482140';

  console.log('=== TEST with correct MAX chatId ===');
  console.log(`chatId=${chatId}`);

  const result = await send(chatId, 'TEST-OK: Это сообщение с правильным chatId!');
  console.log('Result:', result);
}

main().catch(console.error);
