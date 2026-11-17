const fetch = require('node-fetch');

async function testWebhook() {
  const url = 'http://localhost:3002/api/webhook/telegram';
  const payload = {
    telegramId: (process.env.YOKO_SCRIPT_TELEGRAM_ID || (() => { throw new Error('YOKO_SCRIPT_TELEGRAM_ID is required: no built-in Telegram id'); })()),
    text: 'Test Duplication ' + Date.now(),
    direction: 'INCOMING',
    username: 'testuser'
  };

  console.log('Sending first request...');
  const res1 = await fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-bot-signature': 'secret'
    },
    body: JSON.stringify(payload)
  });
  console.log('Res 1:', await res1.json());

  console.log('Sending immediate second request (simulated duplicate)...');
  const res2 = await fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-bot-signature': 'secret'
    },
    body: JSON.stringify(payload)
  });
  console.log('Res 2:', await res2.json());
}

testWebhook().catch(console.error);
