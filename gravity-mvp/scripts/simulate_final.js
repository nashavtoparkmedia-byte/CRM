const fetch = require('node-fetch');

async function testFinalFix() {
  const url = 'http://localhost:3002/api/webhook/telegram';
  const telegramId = (process.env.YOKO_SCRIPT_TELEGRAM_ID || (() => { throw new Error('YOKO_SCRIPT_TELEGRAM_ID is required: no built-in Telegram id'); })());
  
  const messages = ['Раз (тест)', 'Два (тест)', 'Три (тест)', 'Четыре (тест)', 'Пять (тест)'];

  console.log('Sending 5 messages RAPIDLY...');
  // We use parallel sends to ensure they hit the server at the same time and challenge the sorting
  const promises = messages.map(text => {
    return fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-bot-signature': 'secret'
      },
      body: JSON.stringify({
        telegramId,
        text,
        direction: 'INCOMING',
        username: 'testuser'
      })
    }).then(res => res.json());
  });

  const results = await Promise.all(promises);
  console.log('Results:', results.length, 'messages sent.');
}

testFinalFix().catch(console.error);
