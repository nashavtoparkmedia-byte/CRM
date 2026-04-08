const http = require('http');

const messages = [
  { id: 1, text: 'TEST-1: Привет! Это первое тестовое сообщение из CRM.' },
  { id: 2, text: 'TEST-2: Спецсимволы: <>&"\'\\/ и кавычки «ёлочки»' },
  { id: 3, text: 'TEST-3: Эмодзи 🚀🔥✅❌👍 и флаги 🇷🇺🇺🇸' },
  { id: 4, text: 'TEST-4: Длинное сообщение. '.repeat(30) },
  { id: 5, text: 'TEST-5: Числа и телефоны: +7(922)215-57-50, 100500, 3.14159' },
];

async function send(chatId, message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chatId, message });
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
        console.log(`[MSG ${message.substring(0, 40)}...] status=${res.statusCode} body=${body}`);
        resolve(body);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const chatId = '79222155750';

  // Send first message
  console.log('=== Sending TEST-1 ===');
  await send(chatId, messages[0].text);

  // Wait and check
  console.log('Waiting 3s...');
  await new Promise(r => setTimeout(r, 3000));

  // Send rest one by one with small delays
  for (let i = 1; i < messages.length; i++) {
    console.log(`=== Sending TEST-${i+1} ===`);
    await send(chatId, messages[i].text);
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n=== All messages sent! Check web.max.ru ===');
}

main().catch(console.error);
