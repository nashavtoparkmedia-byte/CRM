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
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const CHAT_ID = '201482140'; // MAX internal ID for +79222155750

const tests = [
  { name: 'Simple text',       msg: 'TEST-1: Simple text message' },
  { name: 'Cyrillic',          msg: 'TEST-2: Кириллица и буквы ЁёЪъЫыЭэ' },
  { name: 'Special chars',     msg: 'TEST-3: Спецсимволы <>&"\'\\/ «ёлочки» — тире' },
  { name: 'Emoji',             msg: 'TEST-4: Эмодзи 🚀🔥✅❌👍🇷🇺' },
  { name: 'Long message',      msg: 'TEST-5: Длинное. '.repeat(50) + 'КОНЕЦ' },
  { name: 'Numbers & phones',  msg: 'TEST-6: +7(922)215-57-50, 100500, 3.14159' },
  { name: 'Multiline',         msg: 'TEST-7: Строка 1\nСтрока 2\nСтрока 3' },
  { name: 'Empty-like',        msg: 'TEST-8:    ' }, // spaces only
];

async function main() {
  console.log('=== FULL OUTBOUND TEST SUITE ===\n');

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    console.log(`[${i+1}/${tests.length}] ${t.name}...`);
    try {
      const r = await send(CHAT_ID, t.msg);
      const ok = r.status === 200;
      console.log(`  ${ok ? 'OK' : 'FAIL'} status=${r.status} body=${r.body}`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Burst test: 5 messages with no delay
  console.log('\n=== BURST TEST (5 msgs, no delay) ===');
  const burst = [];
  for (let i = 1; i <= 5; i++) {
    burst.push(send(CHAT_ID, `BURST-${i}: Message ${i} of 5`));
  }
  const results = await Promise.all(burst);
  results.forEach((r, i) => {
    console.log(`  BURST-${i+1}: status=${r.status} body=${r.body}`);
  });

  console.log('\n=== DONE ===');
}

main().catch(console.error);
